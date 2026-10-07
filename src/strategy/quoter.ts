// Pure quoting logic: given fair value, the book and our inventory, decide
// what to rest. No I/O here, so it is fully unit-testable.
//
// Every quote is expressed as a BUY, so the bot only ever needs USDC:
//   - "bid" side  = BUY UP   at b
//   - "ask" side  = BUY DOWN at 1 - a   (economically a SELL UP at a)
// If both fill, the pair is worth exactly $1 at settlement and we keep a - b.
import type { PulseRewardRules } from "../xo/dataApi.js";

export interface QuoterConfig {
  /** Half-spread around fair value, in price units (0.01 = 1c). */
  halfSpread: number;
  /** Never bid above fair - minEdge or offer below fair + minEdge. */
  minEdge: number;
  /** Shares per quote (>= reward min size). */
  shares: number;
  /** Max net UP-minus-DOWN shares held in one round. */
  maxNetShares: number;
  /** Price shift per share of net inventory (skew), price units. */
  skewPerShare: number;
  /** Stop quoting this many seconds before expiry. */
  pullBeforeExpirySec: number;
  /** Do not quote while fair is outside [floor, 1 - floor]. */
  fairFloor: number;
  /** Stay inside the reward band (|quote - mid| < maxDistance) when possible. */
  rewardAware: boolean;
}

export const DEFAULT_QUOTER: QuoterConfig = {
  halfSpread: 0.015,
  minEdge: 0.006,
  shares: 10,
  maxNetShares: 40,
  skewPerShare: 0.0005,
  pullBeforeExpirySec: 25,
  fairFloor: 0.06,
  rewardAware: true,
};

export interface QuoteInputs {
  fairUp: number;
  secondsToExpiry: number;
  /** Book on the UP token (DOWN quotes map via 1 - p). */
  upBestBid?: number;
  upBestAsk?: number;
  /** Net inventory: UP shares minus DOWN shares held this round. */
  netUp: number;
  rules?: PulseRewardRules;
}

export interface Quote {
  token: "UP" | "DOWN";
  price: number; // price of the token being bought
  shares: number;
  /** Equivalent price on the UP axis (bid = price, ask = 1 - price). */
  upAxisPrice: number;
  leg: "bid" | "ask";
}

export interface QuoteDecision {
  quotes: Quote[];
  reason: string;
  fairUp: number;
  rewardMid?: number;
}

const TICK = 0.001;
const roundDown = (p: number) => Math.floor(p / TICK + 1e-9) * TICK;
const roundUp = (p: number) => Math.ceil(p / TICK - 1e-9) * TICK;
const clampPrice = (p: number) => Math.min(0.999, Math.max(0.001, Number(p.toFixed(3))));

export function decideQuotes(inp: QuoteInputs, cfg: QuoterConfig = DEFAULT_QUOTER): QuoteDecision {
  const { fairUp } = inp;
  if (inp.secondsToExpiry <= cfg.pullBeforeExpirySec)
    return { quotes: [], reason: "too close to expiry", fairUp };
  if (fairUp < cfg.fairFloor || fairUp > 1 - cfg.fairFloor)
    return { quotes: [], reason: "fair too one-sided", fairUp };

  const minShares = Math.max(cfg.shares, inp.rules?.minShares ?? 0);

  // Inventory skew: long UP -> lower both prices to sell UP / stop buying it.
  const center = fairUp - cfg.skewPerShare * inp.netUp;
  let bid = roundDown(center - cfg.halfSpread);
  let ask = roundUp(center + cfg.halfSpread);

  // Reward band: score needs |price - mid| < maxDistance. The reward midpoint
  // comes from the best qualifying bid/ask; with an empty side our own quotes
  // define it, so we only tighten when a real two-sided book exists.
  let rewardMid: number | undefined;
  if (cfg.rewardAware && inp.rules && inp.upBestBid !== undefined && inp.upBestAsk !== undefined) {
    rewardMid = (inp.upBestBid + inp.upBestAsk) / 2;
    const D = inp.rules.maxDistance - TICK; // strictly inside the band
    bid = Math.max(bid, roundUp(rewardMid - D));
    ask = Math.min(ask, roundDown(rewardMid + D));
  }

  // Edge guard beats reward chasing: never quote through fair +/- minEdge.
  bid = Math.min(bid, roundDown(fairUp - cfg.minEdge));
  ask = Math.max(ask, roundUp(fairUp + cfg.minEdge));

  // Post-only: do not cross the resting book.
  if (inp.upBestAsk !== undefined) bid = Math.min(bid, inp.upBestAsk - TICK);
  if (inp.upBestBid !== undefined) ask = Math.max(ask, inp.upBestBid + TICK);

  const quotes: Quote[] = [];
  const canBuyUp = inp.netUp < cfg.maxNetShares;
  const canBuyDown = -inp.netUp < cfg.maxNetShares;
  if (canBuyUp && bid > 0.001) {
    const p = clampPrice(bid);
    quotes.push({ token: "UP", price: p, shares: minShares, upAxisPrice: p, leg: "bid" });
  }
  if (canBuyDown && ask < 0.999) {
    const a = clampPrice(ask);
    quotes.push({ token: "DOWN", price: clampPrice(1 - a), shares: minShares, upAxisPrice: a, leg: "ask" });
  }
  return { quotes, reason: quotes.length === 2 ? "two-sided" : "one-sided (inventory cap)", fairUp, rewardMid };
}

/** True when a resting order should be replaced (moving resets the reward clock). */
export function needsRequote(resting: number, target: number, thresholdTicks = 3): boolean {
  return Math.abs(resting - target) >= thresholdTicks * TICK - 1e-9;
}
