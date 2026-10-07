// Tiny fetch wrapper: timeouts, JSON, and 429 back-off honouring retry_after_ms.

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`HTTP ${status} ${url}: ${body.slice(0, 300)}`);
  }
}

export async function requestJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number; retries?: number } = {},
): Promise<T> {
  const { timeoutMs = 8000, retries = 2, ...rest } = init;
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...rest, signal: ctrl.signal });
      const text = await res.text();
      if (res.status === 429 && attempt < retries) {
        let wait = 1000;
        try {
          wait = Number(JSON.parse(text).retry_after_ms) || wait;
        } catch {
          /* ignore */
        }
        attempt++;
        await sleep(Math.min(wait, 10_000));
        continue;
      }
      if (!res.ok) throw new HttpError(res.status, text, url);
      return (text ? JSON.parse(text) : null) as T;
    } catch (err) {
      const transient = err instanceof Error && (err.name === "AbortError" || err.name === "TypeError");
      if (transient && attempt < retries) {
        attempt++;
        await sleep(300 * attempt);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
