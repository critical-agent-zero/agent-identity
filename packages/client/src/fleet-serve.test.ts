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

  it("serves the page when a query string is attached (auto-connect URLs)", () => {
    const { res, out } = fakeRes();
    handler({ method: "GET", url: "/?api=https://x.example" } as never, res as never);
    expect(out.status).toBe(200);
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

describe("resolveFleetUiFile", () => {
  it("prefers the published layout (package-root fleet/) when present", async () => {
    const { resolveFleetUiFile } = await import("./fleet-serve.js");
    const exists = (p: string) => p === "/pkg/fleet/index.html";
    expect(resolveFleetUiFile("/pkg/dist", exists)).toBe("/pkg/fleet/index.html");
  });

  it("falls back to the dev checkout layout (packages/dist/fleet/)", async () => {
    const { resolveFleetUiFile } = await import("./fleet-serve.js");
    const exists = (p: string) => p === "/repo/packages/dist/fleet/index.html";
    expect(resolveFleetUiFile("/repo/packages/client/src", exists))
      .toBe("/repo/packages/dist/fleet/index.html");
  });

  it("returns undefined when neither layout matches", async () => {
    const { resolveFleetUiFile } = await import("./fleet-serve.js");
    expect(resolveFleetUiFile("/nowhere/src", () => false)).toBeUndefined();
  });
});
