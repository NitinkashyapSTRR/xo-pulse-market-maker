// Fair probability that a Pulse round settles UP.
//
// Settlement: UP if closingTWAP >= K, where K (the price to beat) is the
// previous round's closing TWAP and closingTWAP is the 60-second Chainlink
// TWAP ending at expiry. Under a driftless Brownian model for price:
//
//   tau > W (window not started):  A ~ N(S, sigma^2 S^2 (tau - 2W/3))
//   tau <= W (window in progress):  A = ((W - tau) * a_obs + tau * S)/W + noise,
//                                   noise sd = sigma S tau^1.5 / (W sqrt 3)
//
// where W = 60s, S = spot, a_obs = average already observed in the window.
// P(UP) = Phi((E[A] - K) / sd(A)).

export const TWAP_WINDOW_SEC = 60;

export interface FairInputs {
  spot: number;
  strike: number; // price to beat
  secondsToExpiry: number;
  volPerSqrtSec: number; // log-return vol per sqrt(second)
  /** Average of the reference price already observed inside the closing window. */
  observedWindowAvg?: number;
  /** Additive correction between our feed and the oracle (oracle - ours), USD. */
  basis?: number;
}

export function fairUpProbability(i: FairInputs): number {
  const W = TWAP_WINDOW_SEC;
  const S = i.spot + (i.basis ?? 0);
  const tau = Math.max(0, i.secondsToExpiry);
  const sig = i.volPerSqrtSec * S; // USD per sqrt(second)

  let mean: number;
  let variance: number;
  if (tau > W) {
    mean = S;
    variance = sig * sig * (tau - (2 * W) / 3);
  } else {
    const a = (i.observedWindowAvg ?? S) + (i.basis ?? 0);
    mean = ((W - tau) * a + tau * S) / W;
    variance = (sig * sig * tau ** 3) / (3 * W * W);
  }
  if (variance <= 1e-12) return mean >= i.strike ? 1 : 0;
  return normCdf((mean - i.strike) / Math.sqrt(variance));
}

/** Abramowitz-Stegun 7.1.26 erf approximation; |error| < 1.5e-7. */
export function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/**
 * Vol per sqrt(second) implied by a series of consecutive closing TWAPs
 * (each 300 s apart). Robust: uses the median absolute return scaled to sd.
 */
export function volFromClosings(closings: number[], stepSec = 300): number | undefined {
  if (closings.length < 10) return undefined;
  const rets: number[] = [];
  for (let i = 1; i < closings.length; i++) rets.push(Math.log(closings[i]! / closings[i - 1]!));
  const abs = rets.map(Math.abs).sort((a, b) => a - b);
  const mad = abs[Math.floor(abs.length / 2)]!;
  const sd = mad / 0.6745;
  return sd / Math.sqrt(stepSec);
}
