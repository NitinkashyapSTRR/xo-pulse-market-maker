// BTC/USD reference price: median of independent public spot feeds, sampled
// once a second. Pulse settles on the Chainlink BTC/USD 60s TWAP; we track a
// rolling series so the model can estimate both the spot and the TWAP window.
import { requestJson } from "../xo/http.js";

export interface PriceSample {
  t: number; // ms
  price: number;
}

type Source = { name: string; fetch: () => Promise<number> };

export const DEFAULT_SOURCES: Source[] = [
  {
    name: "coinbase",
    fetch: async () =>
      Number((await requestJson<{ price: string }>("https://api.exchange.coinbase.com/products/BTC-USD/ticker", { timeoutMs: 3000, retries: 0 })).price),
  },
  {
    name: "kraken",
    fetch: async () => {
      const r = await requestJson<{ result: Record<string, { c: [string, string] }> }>(
        "https://api.kraken.com/0/public/Ticker?pair=XBTUSD",
        { timeoutMs: 3000, retries: 0 },
      );
      const first = Object.values(r.result)[0];
      return Number(first?.c[0]);
    },
  },
  {
    name: "bitstamp",
    fetch: async () =>
      Number((await requestJson<{ last: string }>("https://www.bitstamp.net/api/v2/ticker/btcusd/", { timeoutMs: 3000, retries: 0 })).last),
  },
];

export class BtcFeed {
  private samples: PriceSample[] = [];
  private timer?: NodeJS.Timeout;
  lastError?: string;

  constructor(
    private sources: Source[] = DEFAULT_SOURCES,
    private keepMs = 30 * 60_000,
  ) {}

  async poll(now = Date.now()): Promise<number | undefined> {
    const got = await Promise.allSettled(this.sources.map((s) => s.fetch()));
    const prices = got
      .filter((g): g is PromiseFulfilledResult<number> => g.status === "fulfilled")
      .map((g) => g.value)
      .filter((p) => Number.isFinite(p) && p > 0);
    if (!prices.length) {
      this.lastError = "all BTC sources failed";
      return undefined;
    }
    const price = median(prices);
    this.push({ t: now, price });
    return price;
  }

  push(s: PriceSample) {
    this.samples.push(s);
    const cutoff = s.t - this.keepMs;
    while (this.samples.length && this.samples[0]!.t < cutoff) this.samples.shift();
  }

  start(intervalMs = 1000) {
    const tick = () => void this.poll().catch((e) => (this.lastError = String(e)));
    tick();
    this.timer = setInterval(tick, intervalMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  last(): PriceSample | undefined {
    return this.samples[this.samples.length - 1];
  }

  /** Time-weighted average over [fromMs, toMs] (step-hold interpolation). */
  twap(fromMs: number, toMs: number): number | undefined {
    const inside = this.samples.filter((s) => s.t >= fromMs && s.t <= toMs);
    if (!inside.length) return undefined;
    let area = 0;
    let span = 0;
    for (let i = 0; i < inside.length; i++) {
      const cur = inside[i]!;
      const next = inside[i + 1]?.t ?? toMs;
      const dt = Math.max(0, next - cur.t);
      area += cur.price * dt;
      span += dt;
    }
    return span > 0 ? area / span : inside[inside.length - 1]!.price;
  }

  /** Realised volatility of log returns, per sqrt(second), over the last windowMs. */
  realisedVolPerSqrtSec(windowMs = 10 * 60_000): number | undefined {
    const last = this.last();
    if (!last) return undefined;
    const pts = this.samples.filter((s) => s.t >= last.t - windowMs);
    if (pts.length < 30) return undefined;
    let sumSq = 0;
    let totalSec = 0;
    for (let i = 1; i < pts.length; i++) {
      const dt = (pts[i]!.t - pts[i - 1]!.t) / 1000;
      if (dt <= 0) continue;
      const r = Math.log(pts[i]!.price / pts[i - 1]!.price);
      sumSq += r * r;
      totalSec += dt;
    }
    return totalSec > 0 ? Math.sqrt(sumSq / totalSec) : undefined;
  }

  get size() {
    return this.samples.length;
  }
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
