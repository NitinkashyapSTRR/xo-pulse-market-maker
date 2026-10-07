// The main loop. Every tick:
//   1. find the live Pulse round and its UP/DOWN tokens,
//   2. read both books and merge them onto one UP axis,
//   3. compute fair P(UP) from BTC spot, the price to beat and time left,
//   4. decide quotes (edge guard, inventory skew, reward band, expiry pull),
//   5. hand them to the executor (paper or live),
//   6. settle finished rounds and enforce the daily loss limit.
import type { BotConfig } from "./config.js";
import { BtcFeed } from "./feeds/btc.js";
import { fairUpProbability, TWAP_WINDOW_SEC, volFromClosings } from "./model/fairValue.js";
import { decideQuotes, type QuoteDecision } from "./strategy/quoter.js";
import { instantScore } from "./strategy/rewards.js";
import { DataApiClient, type PulseRewardRules, type PulseRound } from "./xo/dataApi.js";
import { OrderbookClient, bestAsk, bestBid, type MarketTokens } from "./xo/orderbook.js";
import type { Executor, MarketView } from "./engine/types.js";
import { sleep } from "./xo/http.js";
import { applyPatch, tunablesOf, validatePatch, type Tunables } from "./dashboard/controls.js";

export interface HistPoint {
  t: number;
  round: number;
  btc: number;
  k: number;
  fair: number;
  bid?: number;
  ask?: number;
  qBid?: number;
  qAsk?: number;
}

export interface BotState {
  mode: string;
  startedAt: number;
  now: number;
  round?: { id: number; cycle: number; startsAt: number; expiresAt: number; priceToBeat: number | null };
  btc?: number;
  basis: number;
  volPerSqrtSec?: number;
  fairUp?: number;
  book?: { bid?: number; ask?: number };
  decision?: QuoteDecision;
  working: unknown[];
  positions: unknown[];
  rewards?: PulseRewardRules;
  scoreToday: number;
  realisedPnl: number;
  halted?: string;
  paused: boolean;
  params: Tunables;
  history: HistPoint[];
  fills: number;
  log: { t: number; msg: string }[];
}

export class PulseMarketMaker {
  readonly data = new DataApiClient();
  readonly feed = new BtcFeed();
  readonly state: BotState;
  private tokensCache = new Map<string, MarketTokens>();
  private currentRoundId?: number;
  private rules?: PulseRewardRules;
  private rulesAt = 0;
  private histVol?: number;
  private histVolAt = 0;
  private basis = 0;
  private pendingSettle = new Set<number>();
  private stopping = false;

  constructor(
    private cfg: BotConfig,
    readonly ob: OrderbookClient,
    readonly exec: Executor & { settle?(id: number, w: "UP" | "DOWN"): void; log?: { t: number; msg: string }[] },
  ) {
    this.state = {
      mode: cfg.mode,
      startedAt: Date.now(),
      now: Date.now(),
      basis: 0,
      working: [],
      positions: [],
      scoreToday: 0,
      realisedPnl: 0,
      paused: false,
      params: tunablesOf(cfg),
      history: [],
      fills: 0,
      log: [],
    };
    this.startedWith = tunablesOf(cfg);
  }

  private startedWith: Tunables;

  /** Dashboard controls. Every path is validated; none can touch keys or mode. */
  async control(body: { action?: string; params?: Record<string, unknown> }): Promise<string> {
    switch (body.action) {
      case "pause":
        this.state.paused = true;
        await this.exec.cancelAll("paused from dashboard");
        this.note("PAUSED from dashboard, all quotes pulled");
        return "paused";
      case "resume":
        if (this.state.halted) throw new Error(`halted: ${this.state.halted}`);
        this.state.paused = false;
        this.note("RESUMED from dashboard");
        return "resumed";
      case "kill":
        this.state.paused = true;
        this.state.halted = "kill switch pressed";
        await this.exec.cancelAll("kill switch");
        this.note("KILL SWITCH: all orders cancelled, bot halted");
        return "killed";
      case "unhalt":
        if (this.exec.mode === "live") throw new Error("restart the process to clear a halt in live mode");
        this.state.halted = undefined;
        this.note("halt cleared (paper)");
        return "cleared";
      case "set": {
        const patch = validatePatch(body.params ?? {}, this.exec.mode, this.startedWith);
        applyPatch(this.cfg, patch);
        const live = this.exec as { maxRoundSpendUsdc?: number };
        if (patch.maxRoundSpendUsdc !== undefined && "maxRoundSpendUsdc" in live)
          live.maxRoundSpendUsdc = patch.maxRoundSpendUsdc;
        this.state.params = tunablesOf(this.cfg);
        this.note(`settings: ${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(" ")}`);
        return "updated";
      }
      default:
        throw new Error("unknown action");
    }
  }

  async run() {
    this.feed.start(1000);
    await sleep(2500); // let a few BTC samples land
    while (!this.stopping) {
      const t0 = Date.now();
      try {
        await this.tick(t0);
      } catch (e) {
        this.note(`tick error: ${(e as Error).message.slice(0, 200)}`);
      }
      await sleep(Math.max(200, this.cfg.loopMs - (Date.now() - t0)));
    }
  }

  async stop() {
    this.stopping = true;
    this.feed.stop();
    await this.exec.cancelAll("shutdown");
  }

  async tick(now: number) {
    this.state.now = now;
    await this.refreshSlowData(now);

    const round = await this.data.liveRound(now);
    if (!round) {
      await this.exec.cancelAll("no live round");
      this.state.round = undefined;
      return this.publish();
    }
    if (this.currentRoundId !== undefined && this.currentRoundId !== round.id) {
      await this.exec.cancelAll("round switch");
      this.pendingSettle.add(this.currentRoundId);
    }
    this.currentRoundId = round.id;
    await this.settleFinished();

    this.state.round = {
      id: round.id,
      cycle: round.cycleNumber,
      startsAt: round.startsAtMs,
      expiresAt: round.expiresAtMs,
      priceToBeat: round.openingPrice,
    };

    if (this.exec.haltReason && !this.state.halted) {
      this.state.halted = this.exec.haltReason;
      this.note(`HALT: ${this.state.halted}`);
    }
    if (this.state.halted || this.state.paused) {
      await this.exec.cancelAll(this.state.halted ?? "paused");
      return this.publish();
    }

    const spot = this.feed.last();
    if (!spot || now - spot.t > 5000 || round.openingPrice == null) {
      await this.exec.cancelAll(!spot ? "no BTC price" : round.openingPrice == null ? "no price to beat yet" : "stale BTC price");
      return this.publish();
    }

    // Oracle basis: K is the oracle's TWAP for the 60 s ending at round start;
    // compare with our own feed's TWAP over the same window (EWMA, capped).
    const ours = this.feed.twap(round.startsAtMs - TWAP_WINDOW_SEC * 1000, round.startsAtMs);
    if (ours !== undefined && now - round.startsAtMs < 60_000) {
      const b = Math.max(-150, Math.min(150, round.openingPrice - ours));
      this.basis = 0.7 * this.basis + 0.3 * b;
    }

    const tokens = await this.tokens(round);
    const [upBook, downBook] = await Promise.all([this.ob.book(tokens.up), this.ob.book(tokens.down)]);
    // Merge: UP bid = max(UP bid, 1 - DOWN ask); UP ask = min(UP ask, 1 - DOWN bid).
    const ub = bestBid(upBook);
    const ua = bestAsk(upBook);
    const db = bestBid(downBook);
    const da = bestAsk(downBook);
    const upBestBid = maxDef(ub, da !== undefined ? round3(1 - da) : undefined);
    const upBestAsk = minDef(ua, db !== undefined ? round3(1 - db) : undefined);

    const secondsToExpiry = (round.expiresAtMs - now) / 1000;
    const vol = this.vol();
    const windowStart = round.expiresAtMs - TWAP_WINDOW_SEC * 1000;
    const fairUp = fairUpProbability({
      spot: spot.price,
      strike: round.openingPrice,
      secondsToExpiry,
      volPerSqrtSec: vol,
      observedWindowAvg: now > windowStart ? this.feed.twap(windowStart, now) : undefined,
      basis: this.basis,
    });

    const pos = this.exec.position(round.id);
    const netUp = pos ? pos.upShares - pos.downShares : 0;
    const view: MarketView = { round, tokens, upBestBid, upBestAsk };
    // Quote against the book without our own orders in it.
    const others = this.bookExcludingOurs(view);
    const decision = decideQuotes(
      { fairUp, secondsToExpiry, upBestBid: others.bid, upBestAsk: others.ask, netUp, rules: this.rules },
      this.cfg.quoter,
    );
    await this.exec.sync(view, decision.quotes, now);

    if (this.rules) {
      const mid = upBestBid !== undefined && upBestAsk !== undefined ? (upBestBid + upBestAsk) / 2 : undefined;
      const resting = this.exec.working().map((o) => ({
        leg: o.leg,
        upAxisPrice: o.upAxisPrice,
        shares: o.shares - o.filled,
        restedMs: now - o.placedAt,
      }));
      this.state.scoreToday += (instantScore(resting, mid, this.rules) * this.cfg.loopMs) / 1000;
    }

    Object.assign(this.state, {
      btc: spot.price,
      basis: this.basis,
      volPerSqrtSec: vol,
      fairUp,
      book: { bid: upBestBid, ask: upBestAsk },
      decision,
    });
    const qb = decision.quotes.find((q) => q.leg === "bid");
    const qa = decision.quotes.find((q) => q.leg === "ask");
    this.state.history.push({
      t: now,
      round: round.cycleNumber,
      btc: spot.price,
      k: round.openingPrice,
      fair: fairUp,
      bid: upBestBid,
      ask: upBestAsk,
      qBid: qb?.upAxisPrice,
      qAsk: qa?.upAxisPrice,
    });
    if (this.state.history.length > 600) this.state.history.splice(0, this.state.history.length - 600);
    this.publish();
  }

  /** Our own resting quotes sit in the public book; strip them before quoting. */
  private bookExcludingOurs(view: MarketView) {
    if (this.exec.mode === "paper") return { bid: view.upBestBid, ask: view.upBestAsk };
    const mine = this.exec.working();
    const bid = mine.some((o) => o.leg === "bid" && Math.abs(o.upAxisPrice - (view.upBestBid ?? -1)) < 1e-9)
      ? undefined
      : view.upBestBid;
    const ask = mine.some((o) => o.leg === "ask" && Math.abs(o.upAxisPrice - (view.upBestAsk ?? -1)) < 1e-9)
      ? undefined
      : view.upBestAsk;
    return { bid, ask };
  }

  private vol(): number {
    const live = this.feed.realisedVolPerSqrtSec();
    const hist = this.histVol;
    // Spot polling adds microstructure noise; lean on the oracle history.
    const v = hist !== undefined && live !== undefined ? 0.75 * hist + 0.25 * live : (hist ?? live ?? 0.00006);
    return Math.max(0.00002, Math.min(0.0005, v));
  }

  private async refreshSlowData(now: number) {
    if (now - this.rulesAt > 60_000) {
      this.rulesAt = now;
      try {
        const prevEpoch = this.rules?.epoch;
        this.rules = await this.data.pulseRewardRules();
        if (prevEpoch !== undefined && this.rules && this.rules.epoch !== prevEpoch) this.state.scoreToday = 0;
        this.state.rewards = this.rules;
      } catch (e) {
        this.note(`reward rules unavailable: ${(e as Error).message.slice(0, 120)}`);
      }
    }
    if (now - this.histVolAt > 5 * 60_000) {
      this.histVolAt = now;
      try {
        const closed = await this.data.pulseRounds({ status: "CLOSED", limit: 100 });
        const closings = closed
          .filter((r) => r.closingPrice)
          .sort((a, b) => a.expiresAtMs - b.expiresAtMs)
          .map((r) => r.closingPrice!);
        this.histVol = volFromClosings(closings);
      } catch {
        /* keep previous */
      }
    }
  }

  private settleAt = 0;
  private async settleFinished() {
    if (!this.pendingSettle.size) return;
    // Results take a little while to post; check every 10 s, not every tick.
    if (Date.now() - this.settleAt < 10_000) return;
    this.settleAt = Date.now();
    const closed = await this.data.pulseRounds({ status: "CLOSED", limit: 10 });
    for (const id of [...this.pendingSettle]) {
      const r = closed.find((x) => x.id === id);
      if (r?.winningOutcome == null) continue;
      this.exec.settle?.(id, r.winningOutcome === 0 ? "UP" : "DOWN");
      this.pendingSettle.delete(id);
    }
    this.state.realisedPnl = this.exec
      .positions()
      .reduce((s, p) => s + (p.settled?.pnl ?? 0), 0);
    if (this.state.realisedPnl <= -Math.abs(this.cfg.maxDailyLossUsdc) && !this.state.halted) {
      this.state.halted = `daily loss limit ${this.cfg.maxDailyLossUsdc} USDC hit`;
      this.note(`HALT: ${this.state.halted}`);
    }
  }

  private async tokens(round: PulseRound): Promise<MarketTokens> {
    const hit = this.tokensCache.get(round.conditionId);
    if (hit) return hit;
    const t = await this.ob.marketTokens(round.conditionId);
    this.tokensCache.set(round.conditionId, t);
    return t;
  }

  private publish() {
    this.state.working = this.exec.working();
    this.state.positions = this.exec.positions().slice(-12);
    this.state.log = [...(this.exec.log ?? []), ...this.ownLog].sort((a, b) => a.t - b.t).slice(-60);
    this.state.fills = (this.exec.log ?? []).filter((l) => l.msg.startsWith("FILL")).length;
  }

  private ownLog: { t: number; msg: string }[] = [];
  private note(msg: string) {
    this.ownLog.push({ t: Date.now(), msg });
    if (this.ownLog.length > 100) this.ownLog.shift();
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const maxDef = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
const minDef = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));
