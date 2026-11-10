import { createHash } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { ContentBlock, MessagesRequest } from "../types.js";
import { lastSummarizedToolCall, sameToolInput, type SummarizedToolCall } from "./compaction.js";
import { firstSummaryTranscript, MESSAGE_BOUNDARY, serializeTranscript } from "./presummary-transcript.js";
import { isMissionOrchestrator } from "./presummary.js";

/**
 * Droid never sends its compaction limit, and the user can change it per model,
 * globally, for Missions orchestrators or per `droid exec` run. Droid checks it
 * after every turn and compacts on the first turn above it, so it can be read
 * from what Droid does: a conversation that continues after a turn of T tokens
 * proves the limit is at least T, which raises the learned limit at once. A
 * compaction below the learned limit may be a manual /compact or an emergency
 * compaction rather than a lowered limit, so lowering waits for two that agree.
 */

export type LimitRole = "chat" | "orchestrator";
export interface LearnedLimit { limit: number; source: "raised" | "lowered"; at: string; pending?: { below: number; atLeast: number } }
interface Conversation { model: string; role: LimitRole; tokens: number; previous?: number; at: number; call?: SummarizedToolCall; firstLength: number; firstHash: string }
interface Logger { info(event: string, data?: unknown): void }

const MAX_LIMIT = 2_000_000;
const AGREE = 0.1;
const CONVERSATIONS = 256;
const CONVERSATION_AGE_MS = 24 * 60 * 60_000;

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export class CompactionLimits {
  private readonly conversations = new Map<string, Conversation>();
  private readonly learned = new Map<string, LearnedLimit>();

  constructor(
    private readonly defaults: Record<LimitRole, number>,
    private readonly logger: Logger,
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (!file) return;
    try {
      const saved = JSON.parse(readFileSync(file, "utf8")) as { limits?: Record<string, LearnedLimit> };
      for (const [key, value] of Object.entries(saved.limits ?? {})) if (Number.isSafeInteger(value?.limit) && value.limit > 0) this.learned.set(key, value);
    } catch { /* first start or unreadable: start from the defaults */ }
  }

  limit(model: string, role: LimitRole): number {
    return this.learned.get(`${model}\0${role}`)?.limit ?? this.defaults[role];
  }

  /** A non-summary request: the conversation went on after its last turn, so Droid's limit is at least that turn's tokens. */
  observeRequest(key: string): void {
    const conversation = this.conversations.get(key);
    if (!conversation) return;
    const current = this.limit(conversation.model, conversation.role);
    if (conversation.tokens > current) this.set(conversation, Math.min(conversation.tokens, MAX_LIMIT), "raised", { tokens: conversation.tokens });
  }

  /** After a turn: the limit Droid will compare these tokens with. */
  observeTurn(key: string, request: MessagesRequest, tokens: number, content: readonly ContentBlock[]): { limit: number; role: LimitRole } {
    const role: LimitRole = isMissionOrchestrator(request) ? "orchestrator" : "chat";
    const old = this.conversations.get(key);
    let firstLength = old?.firstLength, firstHash = old?.firstHash;
    if (firstHash === undefined) {
      const first = request.messages[0] ? serializeTranscript([request.messages[0]]) : "";
      firstLength = first.length; firstHash = digest(first);
    }
    const last = [...content].reverse().find((block) => block.type === "tool_use") as { name?: string; input?: unknown } | undefined;
    this.conversations.delete(key);
    this.conversations.set(key, { model: request.model, role, tokens, ...(old ? { previous: old.tokens } : {}), at: this.now(),
      ...(last?.name ? { call: { name: last.name, input: last.input ?? null } } : {}), firstLength: firstLength!, firstHash });
    this.prune();
    return { limit: this.limit(request.model, role), role };
  }

  /** Droid's summary request. Numbers only, for the log. */
  observeCompaction(request: MessagesRequest): Record<string, unknown> {
    const call = lastSummarizedToolCall(request);
    const transcript = firstSummaryTranscript(request);
    const now = this.now();
    const matches = [...this.conversations.entries()].filter(([, entry]) => entry.model === request.model && now - entry.at < CONVERSATION_AGE_MS
      && ((call && entry.call && entry.call.name === call.name && sameToolInput(entry.call.input, call.input))
        || (transcript !== undefined && entry.firstLength > 0 && transcript.length >= entry.firstLength
          && (transcript.length === entry.firstLength || transcript.startsWith(MESSAGE_BOUNDARY, entry.firstLength))
          && digest(transcript.slice(0, entry.firstLength)) === entry.firstHash)));
    if (matches.length !== 1) return { linked: false, candidates: matches.length };
    const [key, conversation] = matches[0]!;
    this.conversations.delete(key);
    const current = this.limit(conversation.model, conversation.role);
    const result = { linked: true, model: conversation.model, role: conversation.role, tokens: conversation.tokens, limit: current };
    const id = `${conversation.model}\0${conversation.role}`;
    const learned = this.learned.get(id);
    if (conversation.tokens > current) {
      // A threshold compaction where expected; a lone low reading before it was a manual one.
      if (learned?.pending) { delete learned.pending; this.save(); }
      return result;
    }
    const reading = { below: conversation.tokens, atLeast: conversation.previous ?? 0 };
    const pending = learned?.pending;
    if (pending && Math.abs(pending.below - reading.below) <= AGREE * Math.max(pending.below, reading.below)) {
      const below = Math.min(pending.below, reading.below), atLeast = Math.max(pending.atLeast, reading.atLeast);
      const lowered = atLeast > 0 && atLeast < below ? atLeast : Math.round(below * 0.95);
      this.set(conversation, lowered, "lowered", { tokens: conversation.tokens, earlier: pending.below });
      return { ...result, lowered };
    }
    this.learned.set(id, { limit: current, source: learned?.source ?? "raised", at: learned?.at ?? new Date(now).toISOString(), pending: reading });
    this.save();
    return { ...result, pending: true };
  }

  describe(): Record<string, unknown> {
    return { defaults: this.defaults, learned: Object.fromEntries([...this.learned].map(([key, value]) => [key.replace("\0", " "), value])) };
  }

  private set(conversation: Pick<Conversation, "model" | "role">, limit: number, source: LearnedLimit["source"], evidence: Record<string, number>): void {
    const id = `${conversation.model}\0${conversation.role}`;
    const from = this.limit(conversation.model, conversation.role);
    this.learned.set(id, { limit, source, at: new Date(this.now()).toISOString() });
    this.logger.info("compaction_limit_learned", { model: conversation.model, role: conversation.role, from, to: limit, source, ...evidence });
    this.save();
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.conversations) if (now - entry.at > CONVERSATION_AGE_MS) this.conversations.delete(key);
    while (this.conversations.size > CONVERSATIONS) this.conversations.delete(this.conversations.keys().next().value!);
  }

  private save(): void {
    if (!this.file) return;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, limits: Object.fromEntries(this.learned) }), { mode: 0o600 });
      renameSync(temporary, this.file);
    } catch {
      rmSync(temporary, { force: true });
    }
  }
}
