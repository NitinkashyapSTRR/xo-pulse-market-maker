// EIP-712 order signing for XO smart accounts (signatureType = 3).
// Mirrors https://docs.xo.market/guides/smart-accounts byte for byte:
//   1. hash the Order struct under the "XO Market CLOB" domain,
//   2. wrap that digest in the Kernel v3 domain of the smart account,
//   3. ECDSA-sign the wrapped digest with the owner EOA,
//   4. prefix 0x01 || validator address.
import {
  concat,
  getAddress,
  hashTypedData,
  keccak256,
  numberToHex,
  pad,
  toBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  SIDE,
  SIGNATURE_TYPE_XO_SMART_ACCOUNT,
  XO,
  ZERO_ADDRESS,
  ZERO_BYTES16,
  ZERO_BYTES32,
  type Side,
} from "./constants.js";

export interface UnsignedOrder {
  salt: bigint;
  maker: Address;
  signer: Address;
  beneficiary: Address;
  tokenId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  expiration: bigint;
  nonce: bigint;
  identifier: Hex;
  metadata: Hex;
  side: Side;
  signatureType: number;
}

export interface SignedOrderWire {
  salt: string;
  maker: Address;
  signer: Address;
  beneficiary: Address;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  identifier: Hex;
  metadata: Hex;
  side: number;
  signatureType: number;
  signature: Hex;
}

export const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "beneficiary", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint128" },
    { name: "identifier", type: "bytes16" },
    { name: "metadata", type: "bytes32" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
} as const;

export const CLOB_AUTH_TYPES = {
  ClobAuth: [
    { name: "address", type: "address" },
    { name: "timestamp", type: "string" },
    { name: "nonce", type: "uint256" },
    { name: "message", type: "string" },
  ],
} as const;

export function orderDomain(chainId: number = XO.chainId) {
  return {
    name: XO.orderDomainName,
    version: XO.orderDomainVersion,
    chainId,
    verifyingContract: getAddress(XO.ctfExchange),
  } as const;
}

/** keccak("\x19\x01" || domainSeparator || structHash) — what CTFExchange.hashOrder returns. */
export function hashOrder(order: UnsignedOrder, chainId: number = XO.chainId): Hex {
  return hashTypedData({
    domain: orderDomain(chainId),
    types: ORDER_TYPES,
    primaryType: "Order",
    message: order,
  });
}

export function hashClobAuth(address: Address, timestamp: string, nonce: bigint, chainId: number = XO.chainId): Hex {
  return hashTypedData({
    domain: { name: XO.clobAuthDomainName, version: "1", chainId },
    types: CLOB_AUTH_TYPES,
    primaryType: "ClobAuth",
    message: { address: getAddress(address), timestamp, nonce, message: XO.clobAuthMessage },
  });
}

const KERNEL_DOMAIN_TYPEHASH = keccak256(
  toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
);
const KERNEL_SIGNED_TYPEHASH = keccak256(toBytes("Kernel(bytes32 hash)"));

/** Wrap a digest in the smart account's Kernel v3 EIP-712 domain. */
export function wrapKernelDigest(digest: Hex, smartAccount: Address, chainId: number = XO.chainId): Hex {
  const domainSeparator = keccak256(
    concat([
      KERNEL_DOMAIN_TYPEHASH,
      keccak256(toBytes(XO.kernelName)),
      keccak256(toBytes(XO.kernelVersion)),
      pad(numberToHex(chainId), { size: 32 }),
      pad(getAddress(smartAccount), { size: 32 }),
    ]),
  );
  const structHash = keccak256(concat([KERNEL_SIGNED_TYPEHASH, digest]));
  return keccak256(concat(["0x1901", domainSeparator, structHash]));
}

/**
 * A signer bound to one owner key and one smart account. The key lives only in
 * this closure; it is never logged, serialised, or sent anywhere.
 */
export class XoSigner {
  readonly smartAccount: Address;
  readonly owner: Address;
  readonly chainId: number;
  #sign: (hash: Hex) => Promise<Hex>;

  constructor(ownerPrivateKey: Hex, smartAccount: Address, chainId: number = XO.chainId) {
    const account = privateKeyToAccount(ownerPrivateKey);
    this.owner = account.address;
    this.smartAccount = getAddress(smartAccount);
    this.chainId = chainId;
    this.#sign = (hash) => account.sign({ hash });
  }

  /** XO smart-account signature: 0x01 || validator || ecdsa(wrapKernelDigest(digest)). */
  async signDigest(digest: Hex): Promise<Hex> {
    const wrapped = wrapKernelDigest(digest, this.smartAccount, this.chainId);
    const ecdsa = await this.#sign(wrapped);
    return concat([toHex(1, { size: 1 }), getAddress(XO.kernelEcdsaValidator), ecdsa]);
  }

  async signOrder(order: UnsignedOrder): Promise<SignedOrderWire> {
    const signature = await this.signDigest(hashOrder(order, this.chainId));
    return toWire(order, signature);
  }

  async clobAuthHeaders(nonce = 0n, timestamp = String(Math.floor(Date.now() / 1000))) {
    const digest = hashClobAuth(this.smartAccount, timestamp, nonce, this.chainId);
    return {
      XO_ADDRESS: this.smartAccount,
      XO_SIGNATURE: await this.signDigest(digest),
      XO_TIMESTAMP: timestamp,
      XO_NONCE: String(nonce),
    };
  }
}

export function toWire(o: UnsignedOrder, signature: Hex): SignedOrderWire {
  return {
    salt: o.salt.toString(),
    maker: o.maker,
    signer: o.signer,
    beneficiary: o.beneficiary,
    tokenId: o.tokenId.toString(),
    makerAmount: o.makerAmount.toString(),
    takerAmount: o.takerAmount.toString(),
    expiration: o.expiration.toString(),
    nonce: o.nonce.toString(),
    identifier: o.identifier,
    metadata: o.metadata,
    side: o.side,
    signatureType: o.signatureType,
    signature,
  };
}

/** Convert a price (0.001..0.999) to its integer tick, rejecting off-tick prices. */
export function priceToTick(price: number): number {
  const tick = Math.round(price * 1000);
  if (tick < 1 || tick > 999) throw new Error(`price ${price} outside (0, 1)`);
  if (Math.abs(tick / 1000 - price) > 1e-9) throw new Error(`price ${price} is not on the 0.001 tick`);
  return tick;
}

/**
 * Build a limit order. Sizes are whole shares so tick × size maps to exact
 * 6-decimal micro amounts with no rounding (BUY pays tick×size/1000 USDC).
 */
export function buildLimitOrder(args: {
  smartAccount: Address;
  tokenId: bigint;
  side: Side;
  price: number;
  shares: number;
  expiration?: bigint;
  salt?: bigint;
}): UnsignedOrder {
  if (!Number.isInteger(args.shares) || args.shares <= 0) throw new Error("shares must be a positive integer");
  const tick = BigInt(priceToTick(args.price));
  const shareMicro = BigInt(args.shares) * XO.micro;
  const usdcMicro = (shareMicro * tick) / 1000n;
  const isBuy = args.side === SIDE.BUY;
  const maker = getAddress(args.smartAccount);
  return {
    salt: args.salt ?? randomSalt(),
    maker,
    signer: maker,
    beneficiary: ZERO_ADDRESS,
    tokenId: args.tokenId,
    makerAmount: isBuy ? usdcMicro : shareMicro,
    takerAmount: isBuy ? shareMicro : usdcMicro,
    expiration: args.expiration ?? 0n,
    nonce: 0n,
    identifier: ZERO_BYTES16,
    metadata: ZERO_BYTES32,
    side: args.side,
    signatureType: SIGNATURE_TYPE_XO_SMART_ACCOUNT,
  };
}

function randomSalt(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return BigInt(toHex(bytes));
}
