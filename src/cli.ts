#!/usr/bin/env node
// xo-pulse-mm CLI
//   paper       run against live XO books with virtual orders (default, no keys)
//   live        trade for real with your XO smart account
//   status      print the live round, books, fair value and reward rules
//   calibrate   score the fair-value model on recent settled rounds
//   setup-keys  derive / mint the orderbook API key for your smart account
//   cancel-all  cancel every resting order on your account
import { getAddress, isAddress, isHex } from "viem";
import { loadConfig, loadDotEnv } from "./config.js";
import { PulseMarketMaker } from "./bot.js";
import { startDashboard } from "./dashboard/server.js";
import { PaperExecutor } from "./engine/paper.js";
import { LiveExecutor } from "./engine/live.js";
import { OrderbookClient, bestAsk, bestBid } from "./xo/orderbook.js";
import { DataApiClient } from "./xo/dataApi.js";
import { XoSigner } from "./xo/signing.js";
import { calibrate } from "./calibrate.js";
import { BtcFeed } from "./feeds/btc.js";
import { fairUpProbability, volFromClosings } from "./model/fairValue.js";

const cmd = process.argv[2] ?? "paper";

async function main() {
  switch (cmd) {
    case "paper":
    case "live":
      return runBot(cmd);
    case "status":
      return status();
    case "calibrate":
      return calibrate(Number(process.argv[3] ?? 200));
    case "setup-keys":
      return setupKeys();
    case "cancel-all":
      return cancelAll();
    default:
      console.error(`unknown command ${cmd}`);
      process.exit(1);
  }
}

function signerFromEnv(): XoSigner {
  loadDotEnv();
  const pk = process.env.XO_OWNER_PRIVATE_KEY;
  const sa = process.env.XO_SMART_ACCOUNT;
  if (!pk || !isHex(pk) || pk.length !== 66) throw new Error("Set XO_OWNER_PRIVATE_KEY (0x + 64 hex) in .env");
  if (!sa || !isAddress(sa)) throw new Error("Set XO_SMART_ACCOUNT (your XO smart wallet address) in .env");
  return new XoSigner(pk, getAddress(sa));
}

async function runBot(mode: "paper" | "live") {
  const cfg = loadConfig(mode);
  const ob = new OrderbookClient();
  let exec;
  if (mode === "live") {
    if (process.env.I_UNDERSTAND_THIS_TRADES_REAL_MONEY !== "yes")
      throw new Error("Live mode trades real USDC. Set I_UNDERSTAND_THIS_TRADES_REAL_MONEY=yes to continue.");
    const signer = signerFromEnv();
    if (!cfg.apiKey || !cfg.apiSecret || !cfg.apiPassphrase)
      throw new Error("Missing XO_API_KEY / XO_API_SECRET / XO_API_PASSPHRASE: run `npm run setup-keys`.");
    ob.setCreds({ apiKey: cfg.apiKey, secret: cfg.apiSecret, passphrase: cfg.apiPassphrase });
    const bal = await ob.balanceAllowance();
    console.log(`smart account ${signer.smartAccount} USDC balance (micro): ${bal.balance}`);
    exec = new LiveExecutor(ob, signer, cfg.requoteTicks, cfg.maxRoundSpendUsdc);
  } else {
    exec = new PaperExecutor(cfg.requoteTicks, cfg.maxRoundSpendUsdc);
  }
  const bot = new PulseMarketMaker(cfg, ob, exec);
  startDashboard(bot, cfg.dashboardPort);
  console.log(`[${mode}] dashboard → http://127.0.0.1:${cfg.dashboardPort}  (pause, kill switch and tuning live there)`);
  const shutdown = async () => {
    console.log("\nshutting down, cancelling orders…");
    await bot.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Console heartbeat every 10 s.
  setInterval(() => {
    const s = bot.state;
    const q = (s.decision?.quotes ?? []).map((x) => `${x.leg}@${x.upAxisPrice.toFixed(3)}`).join(" ");
    console.log(
      `${new Date().toISOString()} round=${s.round?.cycle ?? "-"} btc=${s.btc?.toFixed(2) ?? "-"} K=${s.round?.priceToBeat?.toFixed(2) ?? "-"} fair=${s.fairUp?.toFixed(3) ?? "-"} book=${s.book?.bid ?? "-"}/${s.book?.ask ?? "-"} quotes=[${q}] ${s.decision?.reason ?? ""} pnl=${s.realisedPnl.toFixed(3)} score=${s.scoreToday.toFixed(0)}`,
    );
  }, 10_000);
  await bot.run();
}

async function status() {
  const data = new DataApiClient();
  const ob = new OrderbookClient();
  const feed = new BtcFeed();
  const [round, rules, closed, spot] = await Promise.all([
    data.liveRound(),
    data.pulseRewardRules(),
    data.pulseRounds({ status: "CLOSED", limit: 100 }),
    feed.poll(),
  ]);
  if (!round) return console.log("no live Pulse round right now");
  const tokens = await ob.marketTokens(round.conditionId);
  const [up, down] = await Promise.all([ob.book(tokens.up), ob.book(tokens.down)]);
  const vol = volFromClosings(closed.filter((r) => r.closingPrice).sort((a, b) => a.expiresAtMs - b.expiresAtMs).map((r) => r.closingPrice!)) ?? 0.00006;
  const tte = (round.expiresAtMs - Date.now()) / 1000;
  const fair = round.openingPrice && spot ? fairUpProbability({ spot, strike: round.openingPrice, secondsToExpiry: tte, volPerSqrtSec: vol }) : undefined;
  console.log(JSON.stringify({
    round: { id: round.id, cycle: round.cycleNumber, conditionId: round.conditionId, secondsLeft: Math.round(tte), priceToBeat: round.openingPrice },
    btcSpot: spot,
    vol5minPct: +(vol * Math.sqrt(300) * 100).toFixed(4),
    fairUp: fair && +fair.toFixed(4),
    upBook: { bid: bestBid(up), ask: bestAsk(up), levels: up.bids.length + up.asks.length },
    downBook: { bid: bestBid(down), ask: bestAsk(down), levels: down.bids.length + down.asks.length },
    rewards: rules,
  }, null, 2));
}

async function setupKeys() {
  const signer = signerFromEnv();
  const ob = new OrderbookClient();
  const creds = await ob.deriveOrCreateApiKey(signer);
  console.log("Add these three lines to your .env (keep them private, never commit them):\n");
  console.log(`XO_API_KEY=${creds.apiKey}`);
  console.log(`XO_API_SECRET=${creds.secret}`);
  console.log(`XO_API_PASSPHRASE=${creds.passphrase}`);
}

async function cancelAll() {
  const cfg = loadConfig("live");
  if (!cfg.apiKey || !cfg.apiSecret || !cfg.apiPassphrase) throw new Error("API creds missing");
  const ob = new OrderbookClient(undefined, { apiKey: cfg.apiKey, secret: cfg.apiSecret, passphrase: cfg.apiPassphrase });
  console.log(await ob.cancelAll());
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
