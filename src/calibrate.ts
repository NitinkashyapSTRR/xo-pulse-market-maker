// Offline check of the fair-value model on real settled Pulse rounds.
// For each round we rebuild what the bot would have known at 4, 3, 2 and 1
// minute(s) before expiry (Coinbase 1-minute closes as spot, oracle price to
// beat, vol from the previous 48 oracle closings) and compare P(UP) with the
// actual winner. Reports Brier score vs. the 0.25 coin-flip baseline and a
// reliability table.
import { DataApiClient, type PulseRound } from "./xo/dataApi.js";
import { requestJson } from "./xo/http.js";
import { fairUpProbability, volFromClosings } from "./model/fairValue.js";

type Candle = [number, number, number, number, number, number]; // t, low, high, open, close, vol

export async function calibrate(n = 200) {
  const data = new DataApiClient();
  const rounds: PulseRound[] = [];
  for (let page = 1; rounds.length < n + 48 && page <= 10; page++) {
    rounds.push(...(await data.pulseRounds({ status: "CLOSED", limit: 100, page })));
  }
  const settled = rounds
    .filter((r) => r.openingPrice && r.closingPrice && r.winningOutcome != null)
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs);
  if (settled.length < 60) throw new Error("not enough settled rounds");

  const from = settled[0]!.startsAtMs - 120_000;
  const to = settled[settled.length - 1]!.expiresAtMs;
  const closes = await coinbaseCloses(from, to);

  const checkpoints = [240, 180, 120, 60];
  const rows: { tau: number; p: number; y: number }[] = [];
  for (let i = 48; i < settled.length; i++) {
    const r = settled[i]!;
    const vol = volFromClosings(settled.slice(i - 48, i).map((x) => x.closingPrice!)) ?? 0.00006;
    for (const tau of checkpoints) {
      const t = r.expiresAtMs - tau * 1000;
      const spot = closes.get(Math.floor(t / 60_000) * 60_000 - 60_000); // close of the minute ending at t
      if (!spot) continue;
      const p = fairUpProbability({ spot, strike: r.openingPrice!, secondsToExpiry: tau, volPerSqrtSec: vol });
      rows.push({ tau, p, y: r.winningOutcome === 0 ? 1 : 0 });
    }
  }

  const brier = (xs: typeof rows) => xs.reduce((s, x) => s + (x.p - x.y) ** 2, 0) / xs.length;
  const baseRate = rows.reduce((s, x) => s + x.y, 0) / rows.length;
  console.log(`\nFair-value calibration on ${settled.length - 48} settled BTC 5-min Pulse rounds`);
  console.log(`UP base rate: ${(baseRate * 100).toFixed(1)}%\n`);
  console.log("time left   n     Brier(model)   Brier(coin flip)   skill");
  for (const tau of checkpoints) {
    const xs = rows.filter((x) => x.tau === tau);
    if (!xs.length) continue;
    const b = brier(xs);
    console.log(
      `${String(tau).padStart(5)}s   ${String(xs.length).padStart(4)}   ${b.toFixed(4).padStart(10)}     ${"0.2500".padStart(10)}       ${((1 - b / 0.25) * 100).toFixed(1)}%`,
    );
  }
  console.log("\nReliability (all checkpoints):  predicted → realised UP rate");
  for (let lo = 0; lo < 1; lo += 0.2) {
    const xs = rows.filter((x) => x.p >= lo && x.p < lo + 0.2 + (lo >= 0.8 ? 1e-9 : 0));
    if (!xs.length) continue;
    const pred = xs.reduce((s, x) => s + x.p, 0) / xs.length;
    const real = xs.reduce((s, x) => s + x.y, 0) / xs.length;
    console.log(`  ${lo.toFixed(1)}–${(lo + 0.2).toFixed(1)}   n=${String(xs.length).padStart(4)}   ${(pred * 100).toFixed(1)}% → ${(real * 100).toFixed(1)}%`);
  }
  return { rows: rows.length, brier: brier(rows) };
}

async function coinbaseCloses(fromMs: number, toMs: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const step = 300 * 60_000;
  for (let s = fromMs; s < toMs; s += step) {
    const e = Math.min(toMs, s + step);
    const url = `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`;
    const candles = await requestJson<Candle[]>(url, { timeoutMs: 10_000 });
    for (const c of candles) out.set(c[0] * 1000, c[4]);
  }
  return out;
}
