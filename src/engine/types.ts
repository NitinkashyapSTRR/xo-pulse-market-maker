import type { MarketTokens } from "../xo/orderbook.js";
import type { PulseRound } from "../xo/dataApi.js";
import type { Quote } from "../strategy/quoter.js";

export interface WorkingOrder {
  id: string;
  token: "UP" | "DOWN";
  tokenId: string;
  price: number;
  shares: number;
  filled: number;
  placedAt: number;
  leg: "bid" | "ask";
  upAxisPrice: number;
}

export interface RoundPosition {
  roundId: number;
  conditionId: string;
  upShares: number;
  downShares: number;
  cost: number; // USDC spent
  settled?: { winner: "UP" | "DOWN"; payout: number; pnl: number };
}

export interface MarketView {
  round: PulseRound;
  tokens: MarketTokens;
  /** Effective UP-axis best bid / ask including the complementary DOWN book. */
  upBestBid?: number;
  upBestAsk?: number;
}

export interface Executor {
  readonly mode: "paper" | "live";
  /** Set when the executor can no longer trust its own state; the bot halts. */
  readonly haltReason?: string;
  /** Bring resting orders in line with the desired quotes for this market. */
  sync(view: MarketView, desired: Quote[], now: number): Promise<void>;
  /** Pull everything (round switch, shutdown, kill switch). */
  cancelAll(reason: string): Promise<void>;
  working(): WorkingOrder[];
  position(roundId: number): RoundPosition | undefined;
  positions(): RoundPosition[];
}
