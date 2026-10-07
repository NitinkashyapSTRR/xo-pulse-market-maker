import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOrderStatus } from "../src/engine/live.js";
import type { WorkingOrder } from "../src/engine/types.js";

const mk = (): WorkingOrder => ({
  id: "0xabc", token: "UP", tokenId: "1", price: 0.5, shares: 10, filled: 0,
  placedAt: 0, leg: "bid", upAxisPrice: 0.5,
});

test("vanished order with no status is unknown, never assumed filled", () => {
  const o = mk();
  const r = applyOrderStatus(o, undefined, false);
  assert.equal(r.newFill, 0);
  assert.equal(r.unknown, true);
  assert.equal(o.filled, 0);
});

test("cancelled order with zero matched books no fill", () => {
  const o = mk();
  const r = applyOrderStatus(o, { size_matched: "0", status: "CANCELED" }, false);
  assert.deepEqual(r, { newFill: 0, keep: false, unknown: false });
});

test("partial fill on resting order stays working", () => {
  const o = mk();
  const r = applyOrderStatus(o, { size_matched: "4" }, true);
  assert.deepEqual(r, { newFill: 4, keep: true, unknown: false });
  const r2 = applyOrderStatus(o, { size_matched: "4" }, true);
  assert.equal(r2.newFill, 0);
});

test("fill size is capped at order size", () => {
  const o = mk();
  const r = applyOrderStatus(o, { size_matched: "99" }, false);
  assert.equal(r.newFill, 10);
  assert.equal(r.keep, false);
});
