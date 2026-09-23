import type { IncomingMessage, ServerResponse } from "node:http";

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
    if (req.url !== "/" && req.url !== "/index.html") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  };
}
