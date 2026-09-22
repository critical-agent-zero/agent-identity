import { describe, expect, it } from "vitest";
import {
  SES_INBOUND_REGIONS, defaultDeployRegion, deployChecklist, type ChecklistDeps,
} from "./checklist.js";

const okRun = async () => ({ ok: true, output: '{"Rules": []}' });
const failRun = async () => ({ ok: false, output: "AccessDenied" });

const deps = (over: Partial<ChecklistDeps> = {}): ChecklistDeps => ({
  run: okRun,
  resolveMx: async () => [{ exchange: "inbound-smtp.us-east-1.amazonaws.com" }],
  ...over,
});

// run mock where each tool's result can be overridden by bin name
const tools = (over: Record<string, { ok: boolean; output: string }> = {}): ChecklistDeps =>
  deps({
    run: async (bin) => over[bin] ?? { ok: true, output: bin === "node" ? "v20.11.0" : "ok" },
  });

describe("SES_INBOUND_REGIONS", () => {
  it("lists the regions where SES inbound exists", () => {
    expect(SES_INBOUND_REGIONS).toEqual(["us-east-1", "us-west-2", "eu-west-1"]);
  });
});

describe("defaultDeployRegion", () => {
  it("falls back to us-east-1 when no region env is set", () => {
    expect(defaultDeployRegion({})).toBe("us-east-1");
  });

  it("prefers CDK_DEFAULT_REGION over AWS_REGION, matching infra/bin/app.ts", () => {
    expect(defaultDeployRegion({ CDK_DEFAULT_REGION: "eu-west-1" })).toBe("eu-west-1");
    expect(defaultDeployRegion({ CDK_DEFAULT_REGION: "us-west-2", AWS_REGION: "eu-west-1" }))
      .toBe("us-west-2");
    expect(defaultDeployRegion({ AWS_REGION: "us-west-2" })).toBe("us-west-2");
  });

  it("ignores env regions where SES inbound does not exist", () => {
    expect(defaultDeployRegion({ AWS_REGION: "eu-central-1" })).toBe("us-east-1");
    expect(defaultDeployRegion({ CDK_DEFAULT_REGION: "ap-southeast-2" })).toBe("us-east-1");
  });
});

describe("deployChecklist", () => {
  it("covers preflight, clone, credentials, deploy, ses identity, mx, rule set, fleet key in order", () => {
    expect(deployChecklist("us-east-1").map((s) => s.title)).toEqual([
      "Preflight: required tools",
      "Clone the agent-identity repository",
      "AWS credentials",
      "CDK bootstrap and deploy",
      "SES domain identity and DNS verification records",
      "MX record",
      "Activate the SES receipt rule set",
      "Mint a fleet key",
    ]);
  });

  it("steps without verification are informational", () => {
    const steps = deployChecklist("us-east-1");
    expect(steps[1].verify).toBeUndefined(); // clone
    expect(steps[7].verify).toBeUndefined(); // fleet key (prompted afterwards)
  });

  it("preflight passes when aws, node >= 20, and pnpm are present", async () => {
    expect(await deployChecklist("us-east-1")[0].verify!(tools(), { domain: "d" }))
      .toBeUndefined();
  });

  it("preflight names each missing tool", async () => {
    const noAws = tools({ aws: { ok: false, output: "not found" } });
    expect(await deployChecklist("us-east-1")[0].verify!(noAws, { domain: "d" }))
      .toMatch(/aws CLI/);
    const noPnpm = tools({ pnpm: { ok: false, output: "not found" } });
    expect(await deployChecklist("us-east-1")[0].verify!(noPnpm, { domain: "d" }))
      .toMatch(/pnpm/);
    const both = tools({
      aws: { ok: false, output: "not found" },
      pnpm: { ok: false, output: "not found" },
    });
    const err = await deployChecklist("us-east-1")[0].verify!(both, { domain: "d" });
    expect(err).toMatch(/aws CLI/);
    expect(err).toMatch(/pnpm/);
  });

  it("preflight rejects node older than 20, reporting the found version", async () => {
    const old = tools({ node: { ok: true, output: "v18.19.0" } });
    const err = await deployChecklist("us-east-1")[0].verify!(old, { domain: "d" });
    expect(err).toMatch(/node/);
    expect(err).toMatch(/20/);
    expect(err).toMatch(/v18\.19\.0/);
    const missing = tools({ node: { ok: false, output: "not found" } });
    expect(await deployChecklist("us-east-1")[0].verify!(missing, { domain: "d" }))
      .toMatch(/node/);
  });

  it("verifies AWS credentials via sts get-caller-identity with the explicit region", async () => {
    let cmd: string[] = [];
    const d = deps({ run: async (bin, args) => { cmd = [bin, ...args]; return { ok: true, output: "{}" }; } });
    expect(await deployChecklist("us-east-1")[2].verify!(d, { domain: "mail.example.com" })).toBeUndefined();
    expect(cmd).toEqual(["aws", "sts", "get-caller-identity", "--region", "us-east-1"]);
    expect(await deployChecklist("us-east-1")[2].verify!(deps({ run: failRun }), { domain: "d" }))
      .toMatch(/AccessDenied/);
  });

  it("verifies the stack via describe-stacks AgentIdentity in the chosen region", async () => {
    let cmd: string[] = [];
    const d = deps({ run: async (bin, args) => { cmd = [bin, ...args]; return { ok: true, output: "{}" }; } });
    expect(await deployChecklist("us-west-2")[3].verify!(d, { domain: "mail.example.com" })).toBeUndefined();
    expect(cmd).toEqual([
      "aws", "cloudformation", "describe-stacks", "--stack-name", "AgentIdentity",
      "--region", "us-west-2",
    ]);
  });

  it("embeds the chosen region in the CDK deploy instructions", () => {
    expect(deployChecklist("us-west-2")[3].instructions).toContain("us-west-2");
  });

  it("pins the deploy region via AWS_REGION (the CDK CLI ignores exported CDK_DEFAULT_REGION)", () => {
    expect(deployChecklist("us-west-2")[3].instructions)
      .toMatch(/AWS_REGION=us-west-2 npx cdk deploy/);
  });

  it("verifies the SES identity for the domain in the chosen region", async () => {
    let cmd: string[] = [];
    const d = deps({ run: async (bin, args) => { cmd = [bin, ...args]; return { ok: true, output: "{}" }; } });
    expect(await deployChecklist("eu-west-1")[4].verify!(d, { domain: "mail.example.com" })).toBeUndefined();
    expect(cmd).toEqual([
      "aws", "sesv2", "get-email-identity", "--email-identity", "mail.example.com",
      "--region", "eu-west-1",
    ]);
  });

  it("verifies MX resolution and reports lookup failures", async () => {
    expect(await deployChecklist("us-east-1")[5].verify!(deps(), { domain: "mail.example.com" })).toBeUndefined();
    const noMx = deps({ resolveMx: async () => [] });
    expect(await deployChecklist("us-east-1")[5].verify!(noMx, { domain: "d" })).toMatch(/no MX record/);
    const dnsErr = deps({ resolveMx: async () => { throw new Error("ENODATA"); } });
    expect(await deployChecklist("us-east-1")[5].verify!(dnsErr, { domain: "d" })).toMatch(/ENODATA/);
  });

  it("verifies an active receipt rule set exists in the chosen region", async () => {
    let cmd: string[] = [];
    const d = deps({
      run: async (bin, args) => { cmd = [bin, ...args]; return { ok: true, output: '{"Rules": []}' }; },
    });
    expect(await deployChecklist("us-east-1")[6].verify!(d, { domain: "d" })).toBeUndefined();
    expect(cmd).toEqual(["aws", "ses", "describe-active-receipt-rule-set", "--region", "us-east-1"]);
    const empty = deps({ run: async () => ({ ok: true, output: "" }) });
    expect(await deployChecklist("us-east-1")[6].verify!(empty, { domain: "d" })).toMatch(/no active receipt rule set/);
  });
});

describe("receipt rule set activation warning (#55)", () => {
  it("warns that activation replaces the account's currently active rule set", () => {
    const step = deployChecklist("us-east-1").find((s) => s.title.includes("receipt rule set"))!;
    expect(step.instructions).toMatch(/replaces/i);
    expect(step.instructions).toMatch(/already .*receiv|existing/i);
  });
});
