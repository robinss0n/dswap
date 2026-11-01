import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type { BridgeModel } from "./models.js";
import type { MessagesRequest } from "./types.js";
import { cachedCodexAccountStatus, listCodexAccounts } from "./upstream/codex-accounts.js";
import { cswapExecutable } from "./upstream/cswap-runtime.js";

/**
 * Tier models (`route:<tier>`) let Droid's subagent, mission and compaction settings name a
 * job instead of a model. Each new conversation is sent to Codex or Claude by the combined
 * quota of all signed-in accounts, and stays there so its prompt cache is reused.
 */
export const ROUTE_MODEL_PREFIX = "route:";
export const ROUTE_TIERS = ["light", "medium", "heavy", "worker", "validator", "compaction"] as const;
export type RouteTier = typeof ROUTE_TIERS[number];
export type RouteProvider = "codex" | "claude";
/** Codex goes first until either of its windows reaches this share. */
export const ROUTE_CODEX_LIMIT = 77;

const CLAUDE_TARGETS: Record<RouteTier, string> = {
  light: "haiku", medium: "sonnet", heavy: "opus", worker: "sonnet", validator: "opus", compaction: "sonnet",
};
/** Validators check Codex workers' output, so they stay on the other model family. */
const CLAUDE_EVEN_WHEN_CODEX: ReadonlySet<RouteTier> = new Set(["validator"]);

export function routeModels(): BridgeModel[] {
  return ROUTE_TIERS.map((tier) => ({ id: `${ROUTE_MODEL_PREFIX}${tier}`, model: `${ROUTE_MODEL_PREFIX}${tier}`, displayName: `dswap · ${tier}` }));
}

export function routeTier(id: string): RouteTier | undefined {
  if (!id.startsWith(ROUTE_MODEL_PREFIX)) return undefined;
  const tier = id.slice(ROUTE_MODEL_PREFIX.length);
  return (ROUTE_TIERS as readonly string[]).includes(tier) ? tier as RouteTier : undefined;
}

export interface UsageWindows { fiveHour?: number; week?: number }
export interface CombinedLoad { accounts: number; fiveHour?: number; week?: number; load: number }

/** Average each window over all accounts, then take the fuller window: the pool runs out at the first. */
export function combinedLoad(accounts: UsageWindows[]): CombinedLoad | undefined {
  const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
  const fiveHour = mean(accounts.flatMap((item) => typeof item.fiveHour === "number" ? [item.fiveHour] : []));
  const week = mean(accounts.flatMap((item) => typeof item.week === "number" ? [item.week] : []));
  if (fiveHour === undefined && week === undefined) return undefined;
  return { accounts: accounts.length, ...(fiveHour !== undefined ? { fiveHour } : {}), ...(week !== undefined ? { week } : {}), load: Math.max(fiveHour ?? 0, week ?? 0) };
}

/**
 * Codex while it is under the limit. Past it, Claude takes over, unless Claude's pool is
 * fuller than Codex's: then Codex still has more room left.
 */
export function chooseProvider(codex: number | undefined, claude: number | undefined, limit = ROUTE_CODEX_LIMIT): RouteProvider {
  const codexLoad = codex ?? 101, claudeLoad = claude ?? 101;
  if (codexLoad < limit) return "codex";
  return claudeLoad <= codexLoad ? "claude" : "codex";
}

export interface ProviderLoads { codex?: CombinedLoad; claude?: CombinedLoad }

export function routeTarget(tier: RouteTier, provider: RouteProvider, models: BridgeModel[]): string | undefined {
  const ids = new Set(models.map((model) => model.id));
  const codex = models.find((model) => model.provider === "codex")?.id;
  const claude = ids.has(CLAUDE_TARGETS[tier]) ? CLAUDE_TARGETS[tier] : undefined;
  const preferred = provider === "codex" && !CLAUDE_EVEN_WHEN_CODEX.has(tier) ? codex : claude;
  return preferred ?? claude ?? codex;
}

interface CswapListAccount { disabled?: boolean; usageStatus?: string; usage?: { fiveHour?: { pct?: number }; sevenDay?: { pct?: number } } | null }

/** Signed-in, enabled accounts only: a disabled or signed-out account adds no capacity. */
export async function readProviderLoads(): Promise<ProviderLoads> {
  const claude = promisify(execFile)(cswapExecutable(), ["list", "--json"], { encoding: "utf8", timeout: 20_000 })
    .then(({ stdout }) => {
      const accounts = (JSON.parse(stdout) as { accounts?: CswapListAccount[] }).accounts ?? [];
      return combinedLoad(accounts.filter((item) => item.disabled !== true && item.usage)
        .map((item) => ({ fiveHour: item.usage?.fiveHour?.pct, week: item.usage?.sevenDay?.pct })));
    }).catch(() => undefined);
  const codex = Promise.all(listCodexAccounts().map((item) => cachedCodexAccountStatus(item)))
    .then((statuses) => combinedLoad(statuses.filter((item) => item.status === "ok" || item.status === "limited")
      .map((item) => ({ fiveHour: item.fiveHour?.usedPercent, week: item.weekly?.usedPercent }))))
    .catch(() => undefined);
  const [claudeLoad, codexLoad] = await Promise.all([claude, codex]);
  return { ...(claudeLoad ? { claude: claudeLoad } : {}), ...(codexLoad ? { codex: codexLoad } : {}) };
}

/** A conversation keeps its first user message; Droid resends it with every turn. */
export function conversationKey(request: MessagesRequest, cwd: string | undefined): string {
  const first = request.messages.find((message) => message.role === "user");
  return createHash("sha256").update(JSON.stringify({ cwd: cwd ?? null, first: first?.content ?? null })).digest("hex");
}

export interface RouteDecision { tier: RouteTier; provider: RouteProvider; target: string; loads: ProviderLoads; reused: boolean }

export class ModelRouter {
  private loads?: { at: number; value: Promise<ProviderLoads> };
  private chosen = new Map<string, { target: string; provider: RouteProvider; at: number }>();

  constructor(
    private readonly models: () => BridgeModel[],
    private readonly read: () => Promise<ProviderLoads> = readProviderLoads,
    private readonly now: () => number = Date.now,
    private readonly loadsTtlMs = 5 * 60_000,
    private readonly keepMs = 24 * 60 * 60_000,
  ) {}

  async resolve(requested: string, key: string): Promise<RouteDecision | undefined> {
    const tier = routeTier(requested);
    if (!tier) return undefined;
    const now = this.now(), id = `${requested}\0${key}`;
    const previous = this.chosen.get(id);
    if (previous && now - previous.at < this.keepMs) {
      previous.at = now;
      return { tier, provider: previous.provider, target: previous.target, loads: await this.currentLoads(now), reused: true };
    }
    const loads = await this.currentLoads(now);
    const provider = chooseProvider(loads.codex?.load, loads.claude?.load);
    const target = routeTarget(tier, provider, this.models());
    if (!target) return undefined;
    this.chosen.set(id, { target, provider: target.startsWith("codex:") ? "codex" : "claude", at: now });
    if (this.chosen.size > 2000) {
      for (const [entry, value] of this.chosen) if (now - value.at >= this.keepMs) this.chosen.delete(entry);
    }
    return { tier, provider: this.chosen.get(id)!.provider, target, loads, reused: false };
  }

  private currentLoads(now: number): Promise<ProviderLoads> {
    if (!this.loads || now - this.loads.at >= this.loadsTtlMs) {
      const value = this.read().catch(() => ({}));
      this.loads = { at: now, value };
    }
    return this.loads.value;
  }
}
