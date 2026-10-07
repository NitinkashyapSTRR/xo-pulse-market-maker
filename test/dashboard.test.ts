import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePatch, type Tunables } from "../src/dashboard/controls.js";
import { isTrustedRequest } from "../src/dashboard/server.js";

const start: Tunables = {
  halfSpread: 0.015, minEdge: 0.006, shares: 10, maxNetShares: 40, skewPerShare: 0.0005,
  pullBeforeExpirySec: 25, fairFloor: 0.06, rewardAware: true, maxRoundSpendUsdc: 25, maxDailyLossUsdc: 20,
};

test("paper mode accepts in-range changes", () => {
  assert.deepEqual(validatePatch({ halfSpread: 0.03, shares: 50 }, "paper", start), { halfSpread: 0.03, shares: 50 });
});

test("live mode cannot raise risk caps", () => {
  assert.throws(() => validatePatch({ maxRoundSpendUsdc: 26 }, "live", start), /only be lowered/);
  assert.throws(() => validatePatch({ shares: 11 }, "live", start), /only be lowered/);
  assert.deepEqual(validatePatch({ maxRoundSpendUsdc: 5, halfSpread: 0.05 }, "live", start), { maxRoundSpendUsdc: 5, halfSpread: 0.05 });
});

test("unknown keys, secrets and out-of-range values are rejected", () => {
  assert.throws(() => validatePatch({ ownerPrivateKey: "0x1" }, "paper", start), /unknown/);
  assert.throws(() => validatePatch({ mode: "live" }, "paper", start), /unknown/);
  assert.throws(() => validatePatch({ halfSpread: 5 }, "paper", start), /between/);
  assert.throws(() => validatePatch({ shares: 2.5 }, "paper", start), /whole/);
});

test("controls need localhost host/origin and the run token", () => {
  const ok = { host: "127.0.0.1:8787", origin: "http://127.0.0.1:8787", "x-control-token": "t" };
  assert.equal(isTrustedRequest({ headers: ok }, "t"), true);
  assert.equal(isTrustedRequest({ headers: { ...ok, "x-control-token": "x" } }, "t"), false);
  assert.equal(isTrustedRequest({ headers: { ...ok, origin: "https://evil.example" } }, "t"), false);
  assert.equal(isTrustedRequest({ headers: { ...ok, host: "evil.example:8787" } }, "t"), false);
  assert.equal(isTrustedRequest({ headers: { ...ok, host: "localhost:8787", origin: "http://localhost:8787" } }, "t"), true);
});
