import { test } from "node:test";
import assert from "node:assert/strict";
import { decideQuotes, needsRequote, DEFAULT_QUOTER } from "../src/strategy/quoter.js";
import { instantScore, proximityWeight } from "../src/strategy/rewards.js";
import { fairUpProbability, normCdf, volFromClosings } from "../src/model/fairValue.js";
import { hmacSignature } from "../src/xo/orderbook.js";
import type { PulseRewardRules } from "../src/xo/dataApi.js";

const rules: PulseRewardRules = {
  groupId: "g", maxDistance: 0.02, singleSidedFactor: 3, twoSidedBandLow: 0.3, twoSidedBandHigh: 0.7,
  minShares: 4, minRestMs: 300, usdcDailyPool: 150, cpDailyPool: 1500, usdcAprPct: null,
  qualifyingLiquidityUsd: null, epoch: 1, epochEndsInMs: 0,
};

test("normCdf is accurate", () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normCdf(-1) - 0.158655) < 1e-5);
});

test("fair value: at the money is 50%, moves with spot, converges near expiry", () => {
  const base = { strike: 80000, volPerSqrtSec: 0.00005 };
  assert.ok(Math.abs(fairUpProbability({ ...base, spot: 80000, secondsToExpiry: 200 }) - 0.5) < 1e-9);
  const above = fairUpProbability({ ...base, spot: 80050, secondsToExpiry: 200 });
  const aboveLate = fairUpProbability({ ...base, spot: 80050, secondsToExpiry: 20, observedWindowAvg: 80050 });
  assert.ok(above > 0.55 && above < 1);
  assert.ok(aboveLate > above);
  assert.equal(fairUpProbability({ ...base, spot: 79000, secondsToExpiry: 0, observedWindowAvg: 79000 }), 0);
});

test("vol from closings is positive and sane", () => {
  const xs = Array.from({ length: 60 }, (_, i) => 80000 * Math.exp(0.001 * Math.sin(i * 1.7)));
  const v = volFromClosings(xs)!;
  assert.ok(v > 0 && v < 0.001);
});

test("quotes are two-sided BUYs straddling fair and never through min edge", () => {
  const d = decideQuotes({ fairUp: 0.5, secondsToExpiry: 200, netUp: 0 });
  assert.equal(d.quotes.length, 2);
  const bid = d.quotes.find((q) => q.leg === "bid")!;
  const ask = d.quotes.find((q) => q.leg === "ask")!;
  assert.equal(bid.token, "UP");
  assert.equal(ask.token, "DOWN");
  assert.ok(bid.price <= 0.5 - DEFAULT_QUOTER.minEdge + 1e-9);
  assert.ok(ask.upAxisPrice >= 0.5 + DEFAULT_QUOTER.minEdge - 1e-9);
  assert.ok(Math.abs(ask.price - (1 - ask.upAxisPrice)) < 1e-9);
});

test("reward band pulls quotes inside +/-2c of the book mid, edge guard still wins", () => {
  const d = decideQuotes({ fairUp: 0.5, secondsToExpiry: 200, netUp: 0, upBestBid: 0.49, upBestAsk: 0.51, rules }, { ...DEFAULT_QUOTER, halfSpread: 0.05 });
  for (const q of d.quotes) assert.ok(Math.abs(q.upAxisPrice - 0.5) < 0.02);
  const skewed = decideQuotes({ fairUp: 0.6, secondsToExpiry: 200, netUp: 0, upBestBid: 0.49, upBestAsk: 0.51, rules });
  const bid = skewed.quotes.find((q) => q.leg === "bid");
  if (bid) assert.ok(bid.price < 0.51); // post-only: never crosses the ask
  const ask = skewed.quotes.find((q) => q.leg === "ask")!;
  assert.ok(ask.upAxisPrice >= 0.6 + DEFAULT_QUOTER.minEdge - 1e-9); // won't sell below fair
});

test("inventory cap and expiry pull", () => {
  const longUp = decideQuotes({ fairUp: 0.5, secondsToExpiry: 200, netUp: 999 });
  assert.deepEqual(longUp.quotes.map((q) => q.leg), ["ask"]);
  assert.equal(decideQuotes({ fairUp: 0.5, secondsToExpiry: 10, netUp: 0 }).quotes.length, 0);
  assert.equal(decideQuotes({ fairUp: 0.02, secondsToExpiry: 200, netUp: 0 }).quotes.length, 0);
});

test("requote threshold keeps resting time unless price moved enough", () => {
  assert.equal(needsRequote(0.5, 0.501), false);
  assert.equal(needsRequote(0.5, 0.503), true);
});

test("reward score follows the docs: quadratic proximity, two-sided bonus, min size", () => {
  assert.ok(Math.abs(proximityWeight(0.01, 0.1) - 0.81) < 1e-12); // docs worked example
  assert.equal(proximityWeight(0.1, 0.1), 0);
  const both = instantScore([
    { leg: "bid", upAxisPrice: 0.49, shares: 100, restedMs: 5000 },
    { leg: "ask", upAxisPrice: 0.51, shares: 100, restedMs: 5000 },
  ], 0.5, rules);
  const one = instantScore([{ leg: "bid", upAxisPrice: 0.49, shares: 100, restedMs: 5000 }], 0.5, rules);
  assert.ok(Math.abs(both - 25) < 1e-9); // 100 * ((0.02-0.01)/0.02)^2
  assert.ok(Math.abs(one - 25 / 3) < 1e-9);
  assert.equal(instantScore([{ leg: "bid", upAxisPrice: 0.79, shares: 100, restedMs: 5000 }], 0.8, rules), 0); // outside band, one-sided
  assert.equal(instantScore([{ leg: "bid", upAxisPrice: 0.49, shares: 3, restedMs: 5000 }], 0.5, rules), 0); // below min size
});

test("HMAC signature is URL-safe base64", () => {
  const sig = hmacSignature("c2VjcmV0LXNlY3JldA==", "1791389400", "GET", "/orders?next_cursor=", "");
  assert.match(sig, /^[A-Za-z0-9_\-]+=*$/);
  assert.equal(sig, hmacSignature("c2VjcmV0LXNlY3JldA==", "1791389400", "get", "/orders?next_cursor=", ""));
});

import { PaperExecutor } from "../src/engine/paper.js";
test("paper executor enforces the round spend cap", async () => {
  const ex = new PaperExecutor(3, 5);
  const view = {
    round: { id: 1, conditionId: "0x1" } as never,
    tokens: { up: "u", down: "d" } as never,
    upBestBid: 0.4, upBestAsk: 0.6,
  };
  await ex.sync(view, [
    { token: "UP", leg: "bid", price: 0.45, shares: 10, upAxisPrice: 0.45 },
    { token: "DOWN", leg: "ask", price: 0.45, shares: 10, upAxisPrice: 0.55 },
  ] as never, 0);
  assert.equal(ex.working().length, 1); // 4.5 fits, second 4.5 would breach 5
});
