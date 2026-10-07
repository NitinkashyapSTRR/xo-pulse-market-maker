// Live executor: signs post-only GTC orders with the XO smart-account key
// and keeps them in line with the desired quotes. Orders also carry a GTD
// expiry at the round's end, so nothing can rest past the round even if the
// bot dies.
import { SIDE } from "../xo/constants.js";
import type { OrderbookClient } from "../xo/orderbook.js";
import { buildLimitOrder, type XoSigner } from "../xo/signing.js";
import type { Quote } from "../strategy/quoter.js";
import { needsRequote } from "../strategy/quoter.js";
import type { Executor, MarketView, RoundPosition, WorkingOrder } from "./types.js";

export class LiveExecutor implements Executor {
  readonly mode = "live" as const;
  private orders: WorkingOrder[] = [];
  private pos = new Map<number, RoundPosition>();
  readonly log: { t: number; msg: string }[] = [];
  haltReason?: string;

  constructor(
    private ob: OrderbookClient,
    private signer: XoSigner,
    private requoteTicks = 3,
    public maxRoundSpendUsdc = 25,
  ) {}

  async sync(view: MarketView, desired: Quote[], now: number): Promise<void> {
    await this.reconcile(view);
    const p = this.ensurePos(view);

    const toCancel: WorkingOrder[] = [];
    const keep: WorkingOrder[] = [];
    for (const o of this.orders) {
      const want = desired.find((q) => q.token === o.token);
      if (want && !needsRequote(o.price, want.price, this.requoteTicks)) keep.push(o);
      else toCancel.push(o);
    }
    if (toCancel.length) {
      const r = await this.ob.cancelOrders(toCancel.map((o) => o.id));
      for (const id of r.failed) this.note(now, `cancel failed ${id} (may have filled)`);
    }
    this.orders = keep;

    for (const q of desired) {
      if (keep.some((o) => o.token === q.token)) continue;
      const committed = p.cost + this.orders.reduce((s, o) => s + (o.shares - o.filled) * o.price, 0);
      if (committed + q.shares * q.price > this.maxRoundSpendUsdc) {
        this.noteOnce(now, `cap:${view.round.id}:${q.token}`, `${q.token} paused for this round: ${this.maxRoundSpendUsdc} USDC round spend cap reached`);
        continue;
      }
      const tokenId = q.token === "UP" ? view.tokens.up : view.tokens.down;
      const unsigned = buildLimitOrder({
        smartAccount: this.signer.smartAccount,
        tokenId: BigInt(tokenId),
        side: SIDE.BUY,
        price: q.price,
        shares: q.shares,
        // GTD: expire 1s after the round so nothing outlives it.
        expiration: BigInt(Math.floor(view.round.expiresAtMs / 1000) + 1),
      });
      const signed = await this.signer.signOrder(unsigned);
      try {
        const res = await this.ob.postOrder(signed, "GTD", true);
        if (!res.success) {
          this.note(now, `rejected ${q.token} @${q.price}: ${res.errorMsg}`);
          continue;
        }
        this.orders.push({
          id: res.orderID,
          token: q.token,
          tokenId,
          price: q.price,
          shares: q.shares,
          filled: 0,
          placedAt: now,
          leg: q.leg,
          upAxisPrice: q.upAxisPrice,
        });
        this.note(now, `placed BUY ${q.shares} ${q.token} @${q.price.toFixed(3)} (${res.status})`);
      } catch (e) {
        this.note(now, `post failed ${q.token}: ${(e as Error).message.slice(0, 160)}`);
      }
    }
  }

  /** Use the exchange as the source of truth for what is still resting / filled. */
  private async reconcile(view: MarketView) {
    if (!this.orders.length) return;
    const open = await this.ob.openOrders(view.round.conditionId);
    const p = this.ensurePos(view);
    const next: WorkingOrder[] = [];
    for (const o of this.orders) {
      let live: { size_matched?: string; status?: string } | undefined = open.find(
        (x) => x.id === o.id || (x as { order_hash?: string }).order_hash === o.id,
      );
      let resting = !!live;
      if (!live) {
        // Gone from the open list: it filled, was cancelled, or expired. Ask
        // the exchange which; if it won't say, stop trading rather than guess.
        try {
          live = await this.ob.getOrder(o.id);
        } catch (e) {
          this.haltReason = `order ${o.id} left the book and its fill is unknown (${(e as Error).message.slice(0, 80)}); check it on XO before restarting`;
          this.note(Date.now(), this.haltReason);
          next.push(o);
          continue;
        }
      }
      const r = applyOrderStatus(o, live, resting);
      if (r.newFill > 0) {
        if (o.token === "UP") p.upShares += r.newFill;
        else p.downShares += r.newFill;
        p.cost += r.newFill * o.price;
        this.note(Date.now(), `FILL ${r.newFill} ${o.token} @${o.price.toFixed(3)}`);
      }
      if (r.unknown) {
        this.haltReason = `order ${o.id} reported no fill size; check it on XO before restarting`;
        this.note(Date.now(), this.haltReason);
      }
      if (r.keep) next.push(o);
    }
    this.orders = next;
  }

  async cancelAll(reason: string): Promise<void> {
    try {
      const r = await this.ob.cancelAll();
      if (r.canceled.length) this.note(Date.now(), `cancelled ${r.canceled.length} (${reason})`);
    } catch (e) {
      this.note(Date.now(), `cancel-all error: ${(e as Error).message.slice(0, 160)}`);
    }
    this.orders = [];
  }

  settle(roundId: number, winner: "UP" | "DOWN") {
    const p = this.pos.get(roundId);
    if (!p || p.settled) return;
    const payout = winner === "UP" ? p.upShares : p.downShares;
    p.settled = { winner, payout, pnl: payout - p.cost };
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

/**
 * Pure fill accounting for one order, given what the exchange reports.
 * Never infers a fill from absence: only a reported size_matched counts.
 */
export function applyOrderStatus(
  o: WorkingOrder,
  reported: { size_matched?: string; status?: string } | undefined,
  resting: boolean,
): { newFill: number; keep: boolean; unknown: boolean } {
  const matched = reported?.size_matched != null ? Number(reported.size_matched) : NaN;
  if (!Number.isFinite(matched)) return { newFill: 0, keep: resting, unknown: !resting };
  const newFill = Math.max(0, Math.min(o.shares, matched) - o.filled);
  o.filled = Math.max(o.filled, Math.min(o.shares, matched));
  return { newFill, keep: resting && o.filled < o.shares, unknown: false };
}
