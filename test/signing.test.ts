import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, keccak256, toBytes, concat, recoverAddress, slice, getAddress, type Hex } from "viem";
import { buildLimitOrder, hashOrder, priceToTick, wrapKernelDigest, XoSigner, orderDomain } from "../src/xo/signing.js";
import { SIDE, XO } from "../src/xo/constants.js";

// Throwaway test key (publicly known Hardhat account #0). Never fund it.
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const SMART = "0xCAFE000000000000000000000000000000000A11";

test("BUY amounts encode price x size exactly in micro units", () => {
  const o = buildLimitOrder({ smartAccount: SMART, tokenId: 1n, side: SIDE.BUY, price: 0.55, shares: 100, salt: 1n });
  assert.equal(o.makerAmount, 55_000_000n); // USDC paid
  assert.equal(o.takerAmount, 100_000_000n); // shares received
  assert.equal(o.maker, o.signer);
  assert.equal(o.signatureType, 3);
  const s = buildLimitOrder({ smartAccount: SMART, tokenId: 1n, side: SIDE.SELL, price: 0.123, shares: 7, salt: 1n });
  assert.equal(s.makerAmount, 7_000_000n);
  assert.equal(s.takerAmount, 861_000n);
});

test("off-tick and out-of-range prices are rejected", () => {
  assert.equal(priceToTick(0.5), 500);
  assert.throws(() => priceToTick(0.5005));
  assert.throws(() => priceToTick(1));
  assert.throws(() => priceToTick(0));
});

test("order hash matches a from-scratch Solidity-style encoding", () => {
  const o = buildLimitOrder({ smartAccount: SMART, tokenId: 123456789n, side: SIDE.BUY, price: 0.42, shares: 10, salt: 99n, expiration: 1791389400n });
  const typeHash = keccak256(toBytes(
    "Order(uint256 salt,address maker,address signer,address beneficiary,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint128 nonce,bytes16 identifier,bytes32 metadata,uint8 side,uint8 signatureType)"));
  const structHash = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "bytes16" }, { type: "bytes32" }, { type: "uint8" }, { type: "uint8" }],
    [typeHash, o.salt, o.maker, o.signer, o.beneficiary, o.tokenId, o.makerAmount, o.takerAmount, o.expiration, o.nonce, o.identifier, o.metadata, o.side, o.signatureType]));
  const d = orderDomain();
  const domainSep = keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
    [keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(toBytes(d.name)), keccak256(toBytes(d.version)), BigInt(d.chainId), d.verifyingContract]));
  const expected = keccak256(concat(["0x1901", domainSep, structHash]));
  assert.equal(hashOrder(o), expected);
});

test("smart-account signature = 0x01 || validator || ecdsa(owner) over the Kernel-wrapped digest", async () => {
  const signer = new XoSigner(TEST_KEY, SMART);
  const o = buildLimitOrder({ smartAccount: SMART, tokenId: 5n, side: SIDE.BUY, price: 0.3, shares: 4, salt: 7n });
  const wire = await signer.signOrder(o);
  assert.equal(wire.signature.length, 2 + 2 * (1 + 20 + 65));
  assert.equal(slice(wire.signature, 0, 1), "0x01");
  assert.equal(getAddress(slice(wire.signature, 1, 21)), getAddress(XO.kernelEcdsaValidator));
  const recovered = await recoverAddress({ hash: wrapKernelDigest(hashOrder(o), SMART), signature: slice(wire.signature, 21) });
  assert.equal(recovered, signer.owner);
  assert.equal(wire.makerAmount, "1200000");
  assert.equal(wire.tokenId, "5");
});

test("ClobAuth headers authenticate as the smart account, not the owner", async () => {
  const signer = new XoSigner(TEST_KEY, SMART);
  const h = await signer.clobAuthHeaders(0n, "1791389400");
  assert.equal(h.XO_ADDRESS, getAddress(SMART));
  assert.equal(h.XO_TIMESTAMP, "1791389400");
  assert.ok(h.XO_SIGNATURE.startsWith("0x01"));
});
