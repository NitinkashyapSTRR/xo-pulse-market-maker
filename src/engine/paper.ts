// Paper executor: rests virtual orders against the LIVE XO book and fills
// them when real liquidity trades through our price. No keys, no money.
//
// Fill rule (conservative): a virtual BUY at p fills when the effective best
// ask for that token drops to <= p (someone is now offering at/through our
// price, so a real resting order there would have been hit), or when the
// last trade printed at/through p after our order was placed.
import type { Quote } from "../strategy/quoter.js";
import { needsRequote } from "../strategy/quoter.js";
import type { Executor, MarketView, RoundPosition, WorkingOrder } from "./types.js";

export class PaperExecutor implements Executor {
  readonly mode = "paper" as const;
  private orders: WorkingOrder[] = [];
  private pos = new Map<number, RoundPosition>();
  private seq = 0;
  readonly log: { t: number; msg: string }[] = [];

  constructor(
    private requoteTicks = 3,
    public maxRoundSpendUsdc = 25,
  ) {}

  async sync(view: MarketView, desired: Quote[], now: number): Promise<void> {
    this.matchFills(view, now);

    const keep: WorkingOrder[] = [];
    for (const o of this.orders) {
      const want = desired.find((q) => q.token === o.token);
      if (want && !needsRequote(o.price, want.price, this.requoteTicks) && o.shares - o.filled > 0) keep.push(o);
      else this.note(now, `cancel ${o.token} @${o.price.toFixed(3)}`);
    }
    const p = this.ensurePos(view);
    for (const q of desired) {
      if (keep.some((o) => o.token === q.token)) continue;
      // Same spend cap as live: filled cost plus everything still resting.
      const committed = p.cost + keep.reduce((s, o) => s + (o.shares - o.filled) * o.price, 0);
      if (committed + q.shares * q.price > this.maxRoundSpendUsdc + 1e-9) {
        this.noteOnce(now, `cap:${view.round.id}:${q.token}`, `${q.token} paused for this round: ${this.maxRoundSpendUsdc} USDC round spend cap reached`);
        continue;
      }
      const tokenId = q.token === "UP" ? view.tokens.up : view.tokens.down;
      keep.push({
        id: `paper-${++this.seq}`,
        token: q.token,
        tokenId,
        price: q.price,
        shares: q.shares,
        filled: 0,
        placedAt: now,
        leg: q.leg,
        upAxisPrice: q.upAxisPrice,
      });
      this.note(now, `place BUY ${q.shares} ${q.token} @${q.price.toFixed(3)}`);
    }
    this.orders = keep;
    this.ensurePos(view);
  }

  private matchFills(view: MarketView, now: number) {
    const p = this.ensurePos(view);
    for (const o of this.orders) {
      const remaining = o.shares - o.filled;
      if (remaining <= 0) continue;
      // Effective ask for the token we are buying.
      const ask = o.token === "UP" ? view.upBestAsk : view.upBestBid !== undefined ? 1 - view.upBestBid : undefined;
      if (ask !== undefined && ask <= o.price + 1e-9 && now - o.placedAt > 500) {
        o.filled += remaining;
        if (o.token === "UP") p.upShares += remaining;
        else p.downShares += remaining;
        p.cost += remaining * o.price;
        this.note(now, `FILL BUY ${remaining} ${o.token} @${o.price.toFixed(3)}`);
      }
    }
    this.orders = this.orders.filter((o) => o.shares - o.filled > 0);
  }

  async cancelAll(reason: string): Promise<void> {
    if (this.orders.length) this.note(Date.now(), `cancel all (${reason})`);
    this.orders = [];
  }

  settle(roundId: number, winner: "UP" | "DOWN") {
    const p = this.pos.get(roundId);
    if (!p || p.settled) return;
    const payout = winner === "UP" ? p.upShares : p.downShares;
    p.settled = { winner, payout, pnl: payout - p.cost };
    this.note(Date.now(), `round ${roundId} settled ${winner}: pnl ${p.settled.pnl.toFixed(3)} USDC`);
  }

  working() {
    return this.orders;
  }
  position(roundId: number) {
    return this.pos.get(roundId);
  }
  positions() {
    return [...this.pos.values()];
  }

  private ensurePos(view: MarketView): RoundPosition {
    let p = this.pos.get(view.round.id);
    if (!p) {
      p = { roundId: view.round.id, conditionId: view.round.conditionId, upShares: 0, downShares: 0, cost: 0 };
      this.pos.set(view.round.id, p);
    }
    return p;
  }

  private onceKeys = new Set<string>();
  /** Log a message only the first time its key is seen (stops cap spam). */
  private noteOnce(t: number, key: string, msg: string) {
    if (this.onceKeys.has(key)) return;
    this.onceKeys.add(key);
    if (this.onceKeys.size > 500) this.onceKeys.clear();
    this.note(t, msg);
  }

  private note(t: number, msg: string) {
    this.log.push({ t, msg });
    if (this.log.length > 300) this.log.shift();
  }
}
