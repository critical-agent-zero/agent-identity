import { describe, expect, it } from "vitest";
import { makeFleetHandler } from "./fleet-serve.js";

function fakeRes() {
  const out: { status?: number; headers?: Record<string, string>; body?: string } = {};
  return {
    res: {
      writeHead(status: number, headers: Record<string, string>) { out.status = status; out.headers = headers; },
      end(body?: string) { out.body = body; },
    },
    out,
  };
}

describe("makeFleetHandler", () => {
  const handler = makeFleetHandler("<!doctype html><title>fleet</title>");

  it("serves the dashboard HTML at /", () => {
    const { res, out } = fakeRes();
    handler({ method: "GET", url: "/" } as never, res as never);
    expect(out.status).toBe(200);
    expect(out.headers?.["content-type"]).toContain("text/html");
    expect(out.body).toContain("fleet");
  });

  it("404s every other path (static single page, no surprises)", () => {
    const { res, out } = fakeRes();
    handler({ method: "GET", url: "/etc/passwd" } as never, res as never);
    expect(out.status).toBe(404);
  });

  it("405s non-GET methods", () => {
    const { res, out } = fakeRes();
    handler({ method: "POST", url: "/" } as never, res as never);
    expect(out.status).toBe(405);
  });
});
