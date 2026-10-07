// Configuration from environment variables (see .env.example).
// Secrets are read from the environment only and never printed.
import { readFileSync, existsSync } from "node:fs";
import type { Address, Hex } from "viem";
import { DEFAULT_QUOTER, type QuoterConfig } from "./strategy/quoter.js";

export interface BotConfig {
  mode: "paper" | "live";
  loopMs: number;
  dashboardPort: number;
  requoteTicks: number;
  maxRoundSpendUsdc: number;
  maxDailyLossUsdc: number;
  quoter: QuoterConfig;
  ownerPrivateKey?: Hex;
  smartAccount?: Address;
  apiKey?: string;
  apiSecret?: string;
  apiPassphrase?: string;
}

/** Minimal .env loader so the bot has zero config dependencies. */
export function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const [, k, raw] = m;
    if (process.env[k!] === undefined) process.env[k!] = raw!.replace(/^["']|["']$/g, "");
  }
}

const num = (k: string, d: number) => {
  const v = process.env[k];
  if (v === undefined || v === "") return d;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${k} must be a number`);
  return n;
};

export function loadConfig(mode: "paper" | "live"): BotConfig {
  loadDotEnv();
  const quoter: QuoterConfig = {
    halfSpread: num("MM_HALF_SPREAD", DEFAULT_QUOTER.halfSpread),
    minEdge: num("MM_MIN_EDGE", DEFAULT_QUOTER.minEdge),
    shares: num("MM_SHARES", DEFAULT_QUOTER.shares),
    maxNetShares: num("MM_MAX_NET_SHARES", DEFAULT_QUOTER.maxNetShares),
    skewPerShare: num("MM_SKEW_PER_SHARE", DEFAULT_QUOTER.skewPerShare),
    pullBeforeExpirySec: num("MM_PULL_BEFORE_EXPIRY_SEC", DEFAULT_QUOTER.pullBeforeExpirySec),
    fairFloor: num("MM_FAIR_FLOOR", DEFAULT_QUOTER.fairFloor),
    rewardAware: (process.env.MM_REWARD_AWARE ?? "true") !== "false",
  };
  if (!Number.isInteger(quoter.shares) || quoter.shares < 1) throw new Error("MM_SHARES must be a positive integer");
  return {
    mode,
    loopMs: num("MM_LOOP_MS", 2000),
    dashboardPort: num("DASHBOARD_PORT", 8787),
    requoteTicks: num("MM_REQUOTE_TICKS", 3),
    maxRoundSpendUsdc: num("MM_MAX_ROUND_SPEND_USDC", 25),
    maxDailyLossUsdc: num("MM_MAX_DAILY_LOSS_USDC", 20),
    quoter,
    ownerPrivateKey: (process.env.XO_OWNER_PRIVATE_KEY || undefined) as Hex | undefined,
    smartAccount: (process.env.XO_SMART_ACCOUNT || undefined) as Address | undefined,
    apiKey: process.env.XO_API_KEY || undefined,
    apiSecret: process.env.XO_API_SECRET || undefined,
    apiPassphrase: process.env.XO_API_PASSPHRASE || undefined,
  };
}
