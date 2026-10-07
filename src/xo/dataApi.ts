// XO Data API: Pulse round discovery and the shared Pulse liquidity-reward rules.
import { XO } from "./constants.js";
import { requestJson } from "./http.js";

export interface PulseRound {
  id: number;
  cycleNumber: number;
  conditionId: string;
  status: string; // active | closed | ...
  startsAtMs: number;
  expiresAtMs: number;
  /** Price to beat (previous round's closing TWAP). null until the round opens. */
  openingPrice: number | null;
  closingPrice: number | null;
  /** 0 = UP, 1 = DOWN, null until resolved. */
  winningOutcome: number | null;
}

export interface PulseRewardRules {
  groupId: string;
  maxDistance: number; // in price units, e.g. 0.02
  singleSidedFactor: number; // one-sided score is divided by this
  twoSidedBandLow: number; // outside [low, high] only two-sided quotes score
  twoSidedBandHigh: number;
  minShares: number;
  minRestMs: number;
  usdcDailyPool: number;
  cpDailyPool: number;
  usdcAprPct: number | null;
  qualifyingLiquidityUsd: number | null;
  epoch: number;
  epochEndsInMs: number;
}

interface RawRound {
  id: number;
  cycleNumber: number;
  conditionId: string;
  status: string;
  startsAt: string;
  expiresAt: string;
  openingPrice: string | null;
  closingPrice: string | null;
  winningOutcome: number | null;
  marketConfigName?: string;
}

export class DataApiClient {
  constructor(readonly baseUrl: string = XO.dataApiUrl) {}

  async pulseRounds(opts: { status?: "ACTIVE" | "CLOSED" | "RESOLVED"; limit?: number; page?: number } = {}) {
    const q = new URLSearchParams({
      limit: String(opts.limit ?? 10),
      page: String(opts.page ?? 1),
      sortBy: "expiresAt",
      sortOrder: "DESC",
    });
    if (opts.status) q.set("status", opts.status);
    const res = await requestJson<{ data: RawRound[] }>(`${this.baseUrl}/pulse/markets?${q}`);
    return res.data.map(toRound);
  }

  /** The round currently trading: startsAt <= now < expiresAt. */
  private activeCache: PulseRound[] = [];
  private activeAt = 0;

  /**
   * The round live right now. A round lasts 5 minutes, so the ACTIVE list is
   * cached and only refetched when no cached round covers `now` (round
   * switch) or the price to beat is still missing — at most every 4 s. This
   * keeps the bot far under XO's rate limit.
   */
  async liveRound(nowMs = Date.now()): Promise<PulseRound | undefined> {
    const hit = this.activeCache.find((r) => r.startsAtMs <= nowMs && nowMs < r.expiresAtMs);
    const fresh = nowMs - this.activeAt < 4000;
    if (hit && (hit.openingPrice != null || fresh)) return hit;
    if (!fresh) {
      try {
        this.activeCache = await this.pulseRounds({ status: "ACTIVE", limit: 10 });
        this.activeAt = nowMs;
      } catch (e) {
        if (!hit) throw e; // keep trading the cached round through a blip
        return hit;
      }
    }
    return this.activeCache.find((r) => r.startsAtMs <= nowMs && nowMs < r.expiresAtMs);
  }

  async pulseRewardRules(): Promise<PulseRewardRules | undefined> {
    const res = await requestJson<{
      current_epoch: number;
      current_epoch_ends_in_ms: number;
      groups: {
        group_id: string;
        active: boolean;
        usdc?: RawRail;
        cp?: RawRail;
      }[];
    }>(`${this.baseUrl}/public/liquidity-rewards/groups`);
    const g = res.groups.find((x) => x.active) ?? res.groups[0];
    if (!g) return undefined;
    const cfg = (g.usdc ?? g.cp)?.config;
    if (!cfg) return undefined;
    return {
      groupId: g.group_id,
      maxDistance: Number(cfg.max_distance_cents) / 100,
      singleSidedFactor: Number(cfg.single_sided_factor),
      twoSidedBandLow: Number(cfg.two_sided_band_low),
      twoSidedBandHigh: Number(cfg.two_sided_band_high),
      minShares: Number(cfg.min_order_size_shares),
      minRestMs: Number(cfg.min_order_rest_ms),
      usdcDailyPool: g.usdc?.active ? Number(g.usdc.daily_pool.amount) : 0,
      cpDailyPool: g.cp?.active ? Number(g.cp.daily_pool.amount) : 0,
      usdcAprPct: g.usdc?.estimated_apr ? Number(g.usdc.estimated_apr) : null,
      qualifyingLiquidityUsd: g.usdc?.estimated_apr_basis
        ? Number(g.usdc.estimated_apr_basis.average_qualifying_liquidity_usd)
        : null,
      epoch: res.current_epoch,
      epochEndsInMs: res.current_epoch_ends_in_ms,
    };
  }
}

interface RawRail {
  active: boolean;
  daily_pool: { amount: string };
  estimated_apr?: string | null;
  estimated_apr_basis?: { average_qualifying_liquidity_usd: string } | null;
  config: {
    max_distance_cents: string;
    single_sided_factor: string;
    two_sided_band_low: string;
    two_sided_band_high: string;
    min_order_rest_ms: number;
    min_order_size_shares: number;
  };
}

function toRound(r: RawRound): PulseRound {
  return {
    id: r.id,
    cycleNumber: r.cycleNumber,
    conditionId: r.conditionId,
    status: r.status,
    startsAtMs: Date.parse(r.startsAt),
    expiresAtMs: Date.parse(r.expiresAt),
    openingPrice: r.openingPrice == null ? null : Number(r.openingPrice),
    closingPrice: r.closingPrice == null ? null : Number(r.closingPrice),
    winningOutcome: r.winningOutcome,
  };
}
