// Public XO Market mainnet constants, from https://docs.xo.market/documentation/introduction
// and https://docs.xo.market/guides/smart-accounts. Nothing here is secret.

export const XO = {
  chainId: 3223,
  orderbookUrl: "https://orderbooks.xo.market",
  dataApiUrl: "https://api-mainnet.xo.market/api",
  ctfExchange: "0x4bC5E872256D12E6017dfe466E04c867DC761B77",
  conditionalTokens: "0xCcf1b2C676E2f9A13e5674be0e0DdFF6d0B13909",
  /** Kernel v3 ECDSA validator used to wrap XO smart-account signatures. */
  kernelEcdsaValidator: "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57",
  kernelName: "Kernel",
  kernelVersion: "0.3.1",
  orderDomainName: "XO Market CLOB",
  orderDomainVersion: "1",
  clobAuthDomainName: "ClobAuthDomain",
  clobAuthMessage: "This message attests that I control the given wallet",
  /** Global tick: prices are integers in [1, 999] / 1000. */
  tick: 0.001,
  /** 6-decimal micro units for USDC and outcome shares. */
  micro: 1_000_000n,
} as const;

export const SIDE = { BUY: 0, SELL: 1 } as const;
export type Side = (typeof SIDE)[keyof typeof SIDE];

/** XO smart account (ERC-1271). The only signature type the orderbook accepts today. */
export const SIGNATURE_TYPE_XO_SMART_ACCOUNT = 3;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
export const ZERO_BYTES16 = "0x00000000000000000000000000000000" as const;
export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;
