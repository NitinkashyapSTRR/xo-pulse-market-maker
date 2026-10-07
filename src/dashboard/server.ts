// Local web dashboard (http://127.0.0.1:8787).
//
// Read: GET /state. Control: POST /control (pause, resume, kill switch, tune
// strategy). Controls are guarded three ways:
//   1. the server binds to 127.0.0.1 only;
//   2. every POST must carry a random per-run token that is only embedded in
//      the page this server serves (other sites cannot read it);
//   3. the Origin / Host must be localhost, which blocks DNS-rebinding and
//      cross-site form posts.
// No endpoint can reveal keys, credentials, or switch paper <-> live, and in
// live mode risk limits can only be lowered (see controls.ts).
import { createServer, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import type { BotState } from "../bot.js";
import { RANGES } from "./controls.js";
import { PAGE } from "./page.js";

export interface Controllable {
  state: BotState;
  control(body: { action?: string; params?: Record<string, unknown> }): Promise<string>;
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

export function isTrustedRequest(req: Pick<IncomingMessage, "headers">, token: string): boolean {
  const host = req.headers.host ?? "";
  if (!LOCAL.test(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (!LOCAL.test(new URL(origin).host)) return false;
    } catch {
      return false;
    }
  }
  return req.headers["x-control-token"] === token;
}

export function startDashboard(bot: Controllable, port: number, host = "127.0.0.1") {
  const token = randomBytes(24).toString("hex");
  const page = PAGE.replace("__TOKEN__", token).replace("__RANGES__", JSON.stringify(RANGES));
  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(bot.state, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      return;
    }
    if (req.method === "POST" && req.url === "/control") {
      if (!isTrustedRequest(req, token)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "forbidden" }));
        return;
      }
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 4096) req.destroy();
      });
      req.on("end", async () => {
        try {
          const msg = await bot.control(JSON.parse(body || "{}"));
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: true, msg }));
        } catch (e) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
        }
      });
      return;
    }
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      });
      res.end(page);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, host);
  return server;
}
