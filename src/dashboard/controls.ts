// Validation for dashboard controls. Pure, so it is unit-tested.
// Rules:
//  - every number has a hard range;
//  - in LIVE mode, risk limits (spend cap, daily loss, shares, inventory cap)
//    can only be tightened from the values the bot started with, never raised;
//  - no control can touch keys, credentials, or the trading mode.
import type { BotConfig } from "../config.js";

export interface Tunables {
  halfSpread: number;
  minEdge: number;
  shares: number;
  maxNetShares: number;
  skewPerShare: number;
  pullBeforeExpirySec: number;
  fairFloor: number;
  rewardAware: boolean;
  maxRoundSpendUsdc: number;
  maxDailyLossUsdc: number;
}

type Range = { min: number; max: number; int?: boolean; riskCap?: boolean };
export const RANGES: Record<Exclude<keyof Tunables, "rewardAware">, Range> = {
  halfSpread: { min: 0.002, max: 0.1 },
  minEdge: { min: 0, max: 0.05 },
  shares: { min: 1, max: 500, int: true, riskCap: true },
  maxNetShares: { min: 0, max: 2000, int: true, riskCap: true },
  skewPerShare: { min: 0, max: 0.01 },
  pullBeforeExpirySec: { min: 5, max: 240, int: true },
  fairFloor: { min: 0.01, max: 0.45 },
  maxRoundSpendUsdc: { min: 0, max: 10_000, riskCap: true },
  maxDailyLossUsdc: { min: 0, max: 10_000, riskCap: true },
};

export function tunablesOf(cfg: BotConfig): Tunables {
  return {
    ...cfg.quoter,
    maxRoundSpendUsdc: cfg.maxRoundSpendUsdc,
    maxDailyLossUsdc: cfg.maxDailyLossUsdc,
  };
}

/** Returns the validated patch, or throws with a human-readable reason. */
export function validatePatch(
  patch: Record<string, unknown>,
  mode: "paper" | "live",
  startedWith: Tunables,
): Partial<Tunables> {
  const out: Partial<Tunables> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === "rewardAware") {
      if (typeof v !== "boolean") throw new Error("rewardAware must be true/false");
      out.rewardAware = v;
      continue;
    }
    const r = RANGES[k as keyof typeof RANGES];
    if (!r) throw new Error(`unknown setting ${k}`);
    const n = typeof v === "string" ? Number(v) : v;
    if (typeof n !== "number" || !Number.isFinite(n)) throw new Error(`${k} must be a number`);
    if (r.int && !Number.isInteger(n)) throw new Error(`${k} must be a whole number`);
    if (n < r.min || n > r.max) throw new Error(`${k} must be between ${r.min} and ${r.max}`);
    if (mode === "live" && r.riskCap && n > (startedWith[k as keyof Tunables] as number))
      throw new Error(`${k} can only be lowered in live mode (started at ${startedWith[k as keyof Tunables]})`);
    (out as Record<string, number>)[k] = n;
  }
  return out;
}

export function applyPatch(cfg: BotConfig, p: Partial<Tunables>) {
  const { maxRoundSpendUsdc, maxDailyLossUsdc, ...q } = p;
  Object.assign(cfg.quoter, q);
  if (maxRoundSpendUsdc !== undefined) cfg.maxRoundSpendUsdc = maxRoundSpendUsdc;
  if (maxDailyLossUsdc !== undefined) cfg.maxDailyLossUsdc = maxDailyLossUsdc;
}
