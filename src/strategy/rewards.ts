// Local estimate of the Pulse liquidity-reward score, following
// https://docs.xo.market/product/rewards/liquidity-rewards :
//   proximity weight = ((D - d) / D)^2 for d < D, else 0
//   size counts only if remaining size >= min size
//   one-sided score is divided by single_sided_factor; outside the
//   two-sided band only two-sided quoting scores at all.
// XO's own scorer is authoritative; this is for steering and the dashboard.
import type { PulseRewardRules } from "../xo/dataApi.js";

export interface RestingQuote {
  leg: "bid" | "ask";
  upAxisPrice: number;
  shares: number;
  restedMs: number;
}

export function proximityWeight(distance: number, maxDistance: number): number {
  if (distance >= maxDistance) return 0;
  const x = (maxDistance - distance) / maxDistance;
  return x * x;
}

/** Instantaneous score of our resting quotes (score units per second of resting). */
export function instantScore(quotes: RestingQuote[], mid: number | undefined, rules: PulseRewardRules): number {
  if (mid === undefined) return 0;
  const eligible = quotes.filter((q) => q.shares >= rules.minShares && q.restedMs >= rules.minRestMs);
  const side = (leg: "bid" | "ask") =>
    eligible
      .filter((q) => q.leg === leg)
      .reduce((s, q) => s + q.shares * proximityWeight(Math.abs(q.upAxisPrice - mid), rules.maxDistance), 0);
  const bid = side("bid");
  const ask = side("ask");
  const inBand = mid >= rules.twoSidedBandLow && mid <= rules.twoSidedBandHigh;
  const twoSided = Math.min(bid, ask);
  if (twoSided > 0) return twoSided + (Math.max(bid, ask) - twoSided) / rules.singleSidedFactor;
  return inBand ? Math.max(bid, ask) / rules.singleSidedFactor : 0;
}
