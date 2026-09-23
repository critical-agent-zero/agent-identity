import { existsSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";

/** Locate the bundled dashboard from the caller's module dir. Two layouts:
 *  published package (<root>/dist/cli.js -> <root>/fleet/) and the dev
 *  checkout (packages/client/src -> packages/dist/fleet/). */
export function resolveFleetUiFile(
  moduleDir: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const candidates = [
    join(moduleDir, "..", "fleet", "index.html"),
    join(moduleDir, "..", "..", "dist", "fleet", "index.html"),
  ];
  return candidates.find(exists);
}

/** Handler for the local fleet-dashboard server: one static page, nothing
 *  else. The page itself talks to the deployment's API with a viewer key —
 *  this server never proxies or holds credentials. */
export function makeFleetHandler(html: string) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== "GET") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("method not allowed");
      return;
    }
    const pathname = (req.url ?? "/").split("?")[0];
    if (pathname !== "/" && pathname !== "/index.html") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  };
}
