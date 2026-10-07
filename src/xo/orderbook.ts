// XO Orderbook (CLOB) REST client. Public market data needs no auth; trading
// endpoints use L2 HMAC (https://docs.xo.market/api-reference/authentication).
import { createHmac } from "node:crypto";
import { XO } from "./constants.js";
import { HttpError, requestJson } from "./http.js";
import type { SignedOrderWire, XoSigner } from "./signing.js";

export interface Level {
  price: number;
  size: number;
}
export interface Book {
  tokenId: string;
  bids: Level[]; // best (highest) first
  asks: Level[]; // best (lowest) first
  lastTradePrice: number;
  timestampMs: number;
}
export interface MarketTokens {
  conditionId: string;
  up: string; // "Yes" outcome token = UP
  down: string; // "No" outcome token = DOWN
  active: boolean;
}
export interface ApiCreds {
  apiKey: string;
  secret: string;
  passphrase: string;
}
export interface OpenOrder {
  id: string;
  asset_id: string;
  side: string;
  price: string;
  original_size: string;
  size_matched: string;
  market?: string;
  status?: string;
}

interface RawLevel {
  price: string;
  size: string;
}

export class OrderbookClient {
  constructor(
    readonly baseUrl: string = XO.orderbookUrl,
    private creds?: ApiCreds,
  ) {}

  setCreds(creds: ApiCreds) {
    this.creds = creds;
  }

  // ---------- public ----------
  serverTime(): Promise<number> {
    return requestJson<number>(`${this.baseUrl}/time`);
  }

  async marketTokens(conditionId: string): Promise<MarketTokens> {
    const m = await requestJson<{
      condition_id: string;
      active: boolean;
      tokens: { token_id: string; outcome: string }[];
    }>(`${this.baseUrl}/markets/${conditionId}`);
    const up = m.tokens.find((t) => /^(yes|up)$/i.test(t.outcome));
    const down = m.tokens.find((t) => /^(no|down)$/i.test(t.outcome));
    if (!up || !down) throw new Error(`unexpected outcomes for ${conditionId}`);
    return { conditionId, up: up.token_id, down: down.token_id, active: m.active };
  }

  async book(tokenId: string): Promise<Book> {
    const b = await requestJson<{
      bids: RawLevel[];
      asks: RawLevel[];
      last_trade_price: string;
      timestamp: string;
    }>(`${this.baseUrl}/book?token_id=${tokenId}`);
    const lv = (l: RawLevel): Level => ({ price: Number(l.price), size: Number(l.size) });
    return {
      tokenId,
      bids: b.bids.map(lv).sort((a, c) => c.price - a.price),
      asks: b.asks.map(lv).sort((a, c) => a.price - c.price),
      lastTradePrice: Number(b.last_trade_price),
      timestampMs: Number(b.timestamp),
    };
  }

  feeRateBps(tokenId: string): Promise<{ base_fee: number }> {
    return requestJson(`${this.baseUrl}/fee-rate?token_id=${tokenId}`);
  }

  // ---------- L1: mint / derive the HMAC key ----------
  async deriveOrCreateApiKey(signer: XoSigner): Promise<ApiCreds> {
    const headers = await signer.clobAuthHeaders();
    try {
      return parseCreds(await requestJson(`${this.baseUrl}/auth/derive-api-key`, { headers }));
    } catch (e) {
      if (!(e instanceof HttpError) || e.status !== 404) throw e;
    }
    const fresh = await signer.clobAuthHeaders();
    return parseCreds(
      await requestJson(`${this.baseUrl}/auth/api-key`, {
        method: "POST",
        headers: { ...fresh, "Content-Type": "application/json" },
        body: "{}",
      }),
    );
  }

  // ---------- L2: trading ----------
  postOrder(order: SignedOrderWire, orderType: "GTC" | "GTD" = "GTC", postOnly = true) {
    return this.private<{ success: boolean; errorMsg: string | null; orderID: string; status: string }>(
      "POST",
      "/order",
      { order, orderType, postOnly },
    );
  }

  postOrders(orders: SignedOrderWire[], orderType: "GTC" | "GTD" = "GTC", postOnly = true) {
    return this.private<{ success: boolean; errorMsg: string | null; orderID: string; status: string }[]>(
      "POST",
      "/orders",
      orders.map((order) => ({ order, orderType, postOnly })),
    );
  }

  /** HMAC form of DELETE /order (documented CLOB SDK form: just `orderID`). */
  cancelOrder(orderID: string) {
    return this.private<{ canceled: string[]; notCanceled: Record<string, string> }>("DELETE", "/order", {
      orderID,
    });
  }

  /**
   * Cancel many orders one by one with the HMAC form. The batch / market / all
   * endpoints want an extra EIP-712 cancel signature whose struct is not fully
   * documented yet, so we stay on the documented path.
   */
  async cancelOrders(orderIDs: string[]): Promise<{ canceled: string[]; failed: string[] }> {
    const results = await Promise.allSettled(orderIDs.map((id) => this.cancelOrder(id)));
    const canceled: string[] = [];
    const failed: string[] = [];
    results.forEach((r, i) => (r.status === "fulfilled" ? canceled : failed).push(orderIDs[i]!));
    return { canceled, failed };
  }

  async cancelAll(market?: string) {
    const open = await this.openOrders(market);
    return this.cancelOrders(open.map((o) => o.id));
  }

  /**
   * Look up one order by id (CLOB-style GET /order/{id}). Used only to learn
   * what happened to an order that left the open list. Callers must treat a
   * failure here as "unknown", never as "filled" or "cancelled".
   */
  getOrder(orderID: string) {
    return this.private<OpenOrder & { status?: string }>("GET", `/order/${encodeURIComponent(orderID)}`);
  }

  async openOrders(market?: string): Promise<OpenOrder[]> {
    const out: OpenOrder[] = [];
    let cursor = "";
    for (let i = 0; i < 20; i++) {
      const q = new URLSearchParams({ next_cursor: cursor });
      if (market) q.set("market", market);
      const page = await this.private<{ data: OpenOrder[]; next_cursor: string }>("GET", `/orders?${q}`);
      out.push(...page.data);
      if (!page.next_cursor || page.next_cursor === "LTE=") break;
      cursor = page.next_cursor;
    }
    return out;
  }

  balanceAllowance() {
    return this.private<{ balance: string; allowance?: string }>(
      "GET",
      "/balance-allowance?asset_type=COLLATERAL",
    );
  }

  positions() {
    return this.private<unknown>("GET", "/positions");
  }

  private async private<T>(method: string, pathWithQuery: string, body?: unknown): Promise<T> {
    if (!this.creds) throw new Error("API credentials missing: run `npm run setup-keys` first");
    const raw = body === undefined ? "" : JSON.stringify(body);
    const ts = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      XO_API_KEY: this.creds.apiKey,
      XO_PASSPHRASE: this.creds.passphrase,
      XO_TIMESTAMP: ts,
      XO_SIGNATURE: hmacSignature(this.creds.secret, ts, method, pathWithQuery, raw),
    };
    if (raw) headers["Content-Type"] = "application/json";
    return requestJson<T>(`${this.baseUrl}${pathWithQuery}`, {
      method,
      headers,
      body: raw || undefined,
    });
  }
}

/** URL_SAFE_BASE64(HMAC_SHA256(secret, timestamp + method + path + body)). */
export function hmacSignature(secret: string, ts: string, method: string, path: string, body: string): string {
  const key = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const digest = createHmac("sha256", key.length ? key : secret)
    .update(ts + method.toUpperCase() + path + body)
    .digest("base64");
  return digest.replace(/\+/g, "-").replace(/\//g, "_");
}

function parseCreds(raw: unknown): ApiCreds {
  const r = (raw ?? {}) as Record<string, unknown>;
  const pick = (...k: string[]) => k.map((x) => r[x]).find((v): v is string => typeof v === "string" && !!v) ?? "";
  const creds = {
    apiKey: pick("apiKey", "api_key", "key"),
    secret: pick("secret", "apiSecret", "api_secret"),
    passphrase: pick("passphrase", "api_passphrase"),
  };
  if (!creds.apiKey || !creds.secret || !creds.passphrase) throw new Error("API key triplet incomplete");
  return creds;
}

export function bestBid(b: Book): number | undefined {
  return b.bids[0]?.price;
}
export function bestAsk(b: Book): number | undefined {
  return b.asks[0]?.price;
}
