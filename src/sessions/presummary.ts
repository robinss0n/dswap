import type { PresummaryConfig } from "../config.js";
import { systemText } from "../protocol/content.js";
import type { MessagesRequest, Usage } from "../types.js";
import { commonPrefixLength, firstSummaryTranscript, rewriteFirstSummary, serializeTranscript } from "./presummary-transcript.js";

/**
 * Droid compacts inside its agent loop, so the user waits for the whole summary.
 * When a Claude conversation nears Droid's compaction limit, this writes and checks
 * a summary of the history so far in the background. At Droid's first compaction the
 * summarizer request is turned into an update of that summary with only the newer
 * messages, which takes about as long as a plain summary. Anything that does not
 * match exactly leaves Droid's request unchanged.
 */

/** Marks the bridge's own background requests, which must not start pre-summaries or count as Droid activity. */
export const PRESUMMARY_HEADER = "x-bridge-internal";

const SUMMARY_INSTRUCTIONS = `You write the summary an AI coding agent will continue from once its conversation history is replaced by it.

Cover what the agent needs to continue: the user's requests, decisions, corrections and preferences, kept apart from the assistant's own proposals and assumptions; the current state of the work; what was verified and what was only inferred or planned; open questions and next steps; and the exact identifiers needed to act (paths, commands, hosts, branches, commits, settings). Point to durable files instead of copying them.

Return the summary inside <summary> tags.`;

const CHECK_INSTRUCTIONS = `You check a compaction summary against the conversation it summarizes. An assistant will continue the work using only this summary, so it will trust every statement in it.

Compare the summary with the transcript and correct it:
1. Status: claims that something is done, verified, tested, committed, deployed or agreed must match the transcript. If the transcript shows it was only planned, proposed, inferred or untested, say so.
2. Attribution: credit decisions and statements to whoever made them, the user or the assistant.
3. Exact details: identifiers, paths, commands, numbers, names, commit hashes and URLs must match the transcript exactly. Fix wrong ones. Copy missing important ones word for word.
4. Unsupported content: remove claims the transcript does not support, including details about the user or the environment that do not appear in it.
5. Omissions: add what the assistant needs to continue and the summary lacks: the user's explicit requests and preferences, open questions, unfinished work, the current state, next steps, and pitfalls the conversation discovered.

Keep everything that is correct and keep the structure. Do not shorten the summary. Write the complete corrected summary inside <summary> tags. After it, list your changes briefly inside <changes> tags.`;

export type PresummarySend = (body: MessagesRequest, signal: AbortSignal) => Promise<string>;
interface Logger { info(event: string, data?: unknown): void; warn(event: string, data?: unknown): void }
interface Entry { prefix: string; state: "running" | "ready" | "failed"; startedAt: number; readyAt?: number; summary?: string; controller: AbortController }
export interface PresummaryLimits { entries: number; ageMs: number; timeoutMs: number }
const LIMITS: PresummaryLimits = { entries: 8, ageMs: 6 * 60 * 60_000, timeoutMs: 20 * 60_000 };

/** What Droid compares with its limit: the last call's input, cache and output tokens. */
export function promptTokens(usage: Partial<Usage> | undefined): number {
  return (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0) + (usage?.output_tokens ?? 0);
}

/** Droid gives a Missions orchestrator its own compaction limit and opens its role guidance with this heading. */
export function isMissionOrchestrator(request: MessagesRequest): boolean {
  return /(^|\n)# Workstream orchestrator\n/.test(systemText(request.system));
}

export function summaryText(text: string): string | undefined {
  const match = /<summary>([\s\S]*?)<\/summary>/i.exec(text);
  return match?.[1]?.trim() || undefined;
}

export class Presummaries {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly config: PresummaryConfig,
    private readonly send: PresummarySend,
    private readonly logger: Logger,
    private readonly limits: PresummaryLimits = LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** After a Claude turn. Starts at most one job at a time, and one per conversation. */
  consider(key: string, request: MessagesRequest, tokens: number): boolean {
    const orchestrator = isMissionOrchestrator(request);
    const limit = orchestrator ? this.config.orchestratorLimit : this.config.limit;
    if (tokens < this.config.at * limit || this.entries.has(key)) return false;
    if ([...this.entries.values()].some((entry) => entry.state === "running")) return false;
    this.prune();
    const prefix = serializeTranscript(request.messages);
    if (!prefix) return false;
    const entry: Entry = { prefix, state: "running", startedAt: this.now(), controller: new AbortController() };
    this.entries.set(key, entry);
    this.logger.info("presummary_started", { tokens, limit, orchestrator, messages: request.messages.length, chars: prefix.length });
    void this.run(entry, request.model);
    return true;
  }

  /** At Droid's summarizer request: the update form when a ready pre-summary covers the start of its transcript. */
  take(request: MessagesRequest): { request: MessagesRequest; path: "presummary" | "plain"; reason: string; matchedChars?: number; transcriptChars?: number } {
    const values = [...this.entries.entries()];
    const ready = values.filter(([, entry]) => entry.state === "ready").sort(([, a], [, b]) => (b.readyAt ?? 0) - (a.readyAt ?? 0));
    for (const [key, entry] of ready) {
      const rewritten = rewriteFirstSummary(request, entry.prefix, entry.summary!);
      if (rewritten) {
        this.entries.delete(key);
        return { request: rewritten, path: "presummary", reason: "matched" };
      }
    }
    const reason = ready.length ? "no ready pre-summary matches this transcript"
      : values.some(([, entry]) => entry.state === "running") ? "pre-summary still running" : "no pre-summary";
    const transcript = firstSummaryTranscript(request);
    // Numbers only, never content: how far the closest pre-summary matched Droid's own transcript.
    const closest = transcript === undefined || !ready.length ? undefined
      : Math.max(...ready.map(([, entry]) => commonPrefixLength(transcript, entry.prefix)));
    return { request, path: "plain", reason, ...(closest !== undefined ? { matchedChars: closest, transcriptChars: transcript!.length } : {}) };
  }

  close(): void {
    for (const entry of this.entries.values()) entry.controller.abort();
  }

  describe(): Record<string, number> {
    const states = [...this.entries.values()].map((entry) => entry.state);
    return { running: states.filter((state) => state === "running").length, ready: states.filter((state) => state === "ready").length,
      failed: states.filter((state) => state === "failed").length };
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.state !== "running" && now - entry.startedAt > this.limits.ageMs) this.entries.delete(key);
    const finished = [...this.entries.entries()].filter(([, entry]) => entry.state !== "running").sort(([, a], [, b]) => a.startedAt - b.startedAt);
    while (this.entries.size >= this.limits.entries && finished.length) this.entries.delete(finished.shift()![0]);
  }

  private async run(entry: Entry, model: string): Promise<void> {
    const { signal } = entry.controller;
    const timer = setTimeout(() => entry.controller.abort(), this.limits.timeoutMs);
    timer.unref?.();
    try {
      const draft = summaryText(await this.send({ model, max_tokens: 32_000, system: SUMMARY_INSTRUCTIONS,
        messages: [{ role: "user", content: `Please summarize the following conversation:\n\`\`\`\n${entry.prefix}\n\`\`\`\n\nReturn the summary inside <summary> tags.` }] }, signal));
      if (!draft) throw new Error("the summary reply had no <summary> block");
      let summary = draft, checked = false;
      try {
        const corrected = summaryText(await this.send({ model: this.config.checkModel, max_tokens: 32_000, output_config: { effort: this.config.checkEffort },
          system: CHECK_INSTRUCTIONS, messages: [{ role: "user", content: `Transcript of the conversation:\n\`\`\`\n${entry.prefix}\n\`\`\`\n\nSummary to check:\n<draft>\n${draft}\n</draft>\n\nCheck the draft against the transcript and write the complete corrected summary inside <summary> tags, then your changes inside <changes> tags.` }] }, signal));
        if (corrected) { summary = corrected; checked = true; }
      } catch (error) {
        if (signal.aborted) throw error;
        this.logger.warn("presummary_check_failed", { error: error instanceof Error ? error.message : String(error) });
      }
      entry.summary = summary;
      entry.state = "ready";
      entry.readyAt = this.now();
      this.logger.info("presummary_ready", { ms: entry.readyAt - entry.startedAt, chars: summary.length, checked });
    } catch (error) {
      entry.state = "failed";
      this.logger.warn("presummary_failed", { ms: this.now() - entry.startedAt, error: signal.aborted ? "aborted" : error instanceof Error ? error.message : String(error) });
    } finally {
      clearTimeout(timer);
    }
  }
}
