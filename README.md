# xo-pulse-mm

An open-source, reward-aware market-making bot for **XO Market Pulse**: the BTC Up/Down markets that settle every 5 minutes.

It prices each round from a live BTC feed, quotes both sides inside XO's liquidity-reward band, skews for inventory, and pulls everything before expiry. **Paper mode is the default and needs no keys.**

> ⚠️ **Experimental software. Not financial advice.** In paper testing against live books the strategy *lost* money (see Results). Market-making 5-minute binaries means trading against people who may see BTC move before you do. Run paper mode first, read the code, and never fund more than you can lose.

## Quick start (paper, no keys)

```bash
git clone https://github.com/NitinkashyapSTRR/xo-pulse-market-maker.git
cd xo-pulse-market-maker
npm install
npm run status        # live round, BTC spot, fair value, books, reward rules
npm run paper         # simulated quoting against live XO books
# dashboard: http://127.0.0.1:8787
```

Node 20+.

## Dashboard

Open `http://127.0.0.1:8787` while the bot runs.

- **Live charts**: BTC vs the round's price to beat, and fair P(UP) against the book and your own quotes, for the current round.
- **Pause / Resume** (`P`) pulls all quotes without stopping the process. **Kill switch** (`K`) cancels everything and halts.
- **Strategy sliders** with Safe / Balanced / Tight presets: spread, edge, size, inventory cap, skew, expiry pull, spend cap, loss halt. Changes apply on the next tick.
- **Toasts and optional sound** on fills and round settlements; log filters for fills, orders, errors.

Controls are local-only: the server binds to `127.0.0.1`, every POST needs a random per-run token embedded in the page, and non-localhost origins are refused. No control can read keys or switch paper/live, and in live mode the risk limits can only be lowered.

## How it works

| Piece | File | What it does |
|---|---|---|
| BTC feed | `src/feeds/btc.ts` | Coinbase / Kraken / Bitstamp spot, median of fresh prices, realised vol |
| Fair value | `src/model/fairValue.ts` | P(UP) = Φ(ln(S/K) / σ√τ) with a vol floor and a fat-tail blend |
| Quoter | `src/strategy/quoter.ts` | fair ± half-spread, inventory skew, min-edge guard, tick rounding, expiry pull |
| Rewards | `src/strategy/rewards.ts` | keeps quotes inside the ±max-distance band at ≥ min size, estimates score |
| Paper engine | `src/engine/paper.ts` | conservative fill simulation against the real book, settles on real outcomes |
| Live engine | `src/engine/live.ts` | signs post-only GTD orders, reconciles fills from exchange-reported sizes only |
| XO clients | `src/xo/*` | public orderbook + data API, HMAC L2 auth, Kernel v3 smart-account signing |

Quotes are **BUY-only on both tokens**: "sell UP at p" is posted as "buy DOWN at 1−p", so you never need inventory to short and a matched pair always redeems for $1.

### Order signing

XO accepts smart-account orders only: `signatureType = 3`, `maker == signer == smart account`, and the owner EOA signs the Kernel v3 wrapped EIP-712 digest. See `src/xo/signing.ts` and `test/signing.test.ts`.

- Chain ID `3223`
- CTF Exchange `0x4bC5E872256D12E6017dfe466E04c867DC761B77`
- Conditional Tokens `0xCcf1b2C676E2f9A13e5674be0e0DdFF6d0B13909`
- Orderbook `https://orderbooks.xo.market`, data `https://api-mainnet.xo.market/api`

## Results so far (honest numbers)

**Model calibration** (`npm run calibrate 200`, 252 settled BTC Pulse rounds, Oct 2026):

| Time left | Brier | Skill vs coin flip |
|---|---|---|
| 240 s | 0.2113 | 15.5% |
| 180 s | 0.1764 | 29.4% |
| 120 s | 0.1204 | 51.9% |
| 60 s | 0.0544 | 78.3% |

The model is useful late in a round and weak early. Skill is not profit: the book is often already priced as well as the model.

**Paper run** (≈9 minutes, 3 rounds, default settings): reward-score accrued, but simulated P&L was **−$5.75**, mostly from one round where BTC crossed the strike late and the bot held the losing side at the inventory cap. Wider spreads, a smaller inventory cap, and pulling earlier are the obvious knobs. Treat defaults as a starting point, not a tuned strategy.

## Going live (only if you choose to)

1. Create a **dedicated** XO smart account and fund it with a small amount.
2. `cp .env.example .env` and fill `XO_OWNER_PRIVATE_KEY` and `XO_SMART_ACCOUNT` **locally**. Never paste them anywhere else.
3. `npm run setup-keys` to derive API credentials, then copy them into `.env`.
4. Set `I_UNDERSTAND_THIS_TRADES_REAL_MONEY=yes` and run `npm run live`.
5. Emergency stop: Ctrl-C (cancels on exit) or `npm run cancel-all`.

Safety rails: per-round spend cap, daily loss halt, inventory cap, post-only orders, GTD expiry at round end, and a hard halt whenever an order's fill status can't be confirmed.

## Known limitations

- Live mode has **not** been run against real funds by the author. Expect bugs; start tiny.
- Cancels use the documented per-order HMAC `DELETE /order`. Batch/all cancel endpoints need an EIP-712 cancel signature not yet implemented.
- Reward score shown is a **local estimate**. XO's API reports the minimum rest time as 300 ms while the docs describe 30 s; the bot uses the API value. XO's own rewards page is authoritative.
- Round times are parsed from the data API's date strings; verify on your machine with `npm run status`.
- The API secret is decoded as base64 (CLOB convention); confirm with `npm run setup-keys` before trading.

## Development

```bash
npm run typecheck
npm test
```

CI runs both on every push, plus a read-only `status` smoke test.

## License

MIT. See `LICENSE`. Security notes in `SECURITY.md`.
