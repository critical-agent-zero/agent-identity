import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readFleetKeyFile, readMachineConfig, writeFleetKeyFile } from "./config.js";
import { skillDest } from "./setup.js";
import { runSetup, type SetupDeps } from "./wizard.js";

const tmp = () => mkdtempSync(join(tmpdir(), "aid-wiz-"));

function scripted(answers: string[]) {
  const said: string[] = [];
  const asked: string[] = [];
  return {
    io: {
      ask: async (q: string) => { asked.push(q); return answers.shift() ?? ""; },
      say: (m: string) => { said.push(m); },
    },
    said, asked,
  };
}

function makeDeps(answers: string[], over: Partial<SetupDeps> = {}) {
  const cwd = tmp();
  const base = tmp();
  const skillDir = tmp();
  writeFileSync(join(skillDir, "SKILL.md"), "# skill");
  const { io, said, asked } = scripted(answers);
  const provision = vi.fn(async ({ count }: { count: number }) =>
    Array.from({ length: count }, (_, i) => ({ agentId: `10000${i}`, address: `10000${i}@d` })));
  const deps: SetupDeps = {
    io, cwd, base, skillDir,
    env: {},
    fetchFn: async () => ({ status: 401 }),
    provision: provision as never,
    ...over,
  };
  return { deps, said, asked, cwd, base, provision };
}

// checklist run mock: every verify passes; node reports v20
function okChecklistDeps() {
  const runLog: string[][] = [];
  return {
    runLog,
    checklistDeps: {
      run: async (bin: string, args: string[]) => {
        runLog.push([bin, ...args]);
        if (bin === "node") return { ok: true, output: "v20.11.0" };
        return { ok: true, output: '{"Rules":[]}' };
      },
      resolveMx: async () => [{ exchange: "mx" }],
    },
  };
}

describe("runSetup — connect to existing", () => {
  it("persists config, provisions, writes .mcp.json, installs the skill", async () => {
    // backend=1, apiUrl, fleetKey, count=2, requireGithub=y
    const { deps, cwd, base, provision } = makeDeps(["1", "https://api.example", "fk-1", "2", "y"]);
    await runSetup(deps);
    expect(readMachineConfig(base)).toEqual({ apiUrl: "https://api.example" });
    expect(readFleetKeyFile(base)).toBe("fk-1");
    expect(provision).toHaveBeenCalledWith(
      expect.objectContaining({ count: 2, apiUrl: "https://api.example", fleetKey: "fk-1", base }),
    );
    const mcp = JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers["agent-identity"].env).toEqual({
      AGENT_IDENTITY_API_URL: "https://api.example",
      AGENT_IDENTITY_REQUIRE: "github",
    });
    expect(existsSync(join(skillDest(cwd), "SKILL.md"))).toBe(true);
  });

  it("re-prompts until the API URL validates", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce({ status: 500 })
      .mockResolvedValueOnce({ status: 401 });
    const { deps, said } = makeDeps(["1", "https://bad", "https://good", "fk", "0", "n"], { fetchFn });
    await runSetup(deps);
    expect(said.some((m) => m.includes("unexpected response 500"))).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("keeps an existing fleet key when the prompt is left empty", async () => {
    const { deps, base } = makeDeps(["1", "https://api", "", "0", "n"]);
    writeFleetKeyFile("existing-key", base);
    await runSetup(deps);
    expect(readFleetKeyFile(base)).toBe("existing-key");
  });

  it("aborts without touching a corrupt .mcp.json", async () => {
    const { deps, cwd } = makeDeps(["1", "https://api", "fk", "0", "n"]);
    writeFileSync(join(cwd, ".mcp.json"), "{nope");
    await expect(runSetup(deps)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe("{nope");
  });

  it("asks before overwriting an installed skill and honours 'n'", async () => {
    // extra final answer "n" for the overwrite prompt
    const { deps, cwd } = makeDeps(["1", "https://api", "fk", "0", "n", "n"]);
    mkdirSync(skillDest(cwd), { recursive: true });
    writeFileSync(join(skillDest(cwd), "SKILL.md"), "old");
    await runSetup(deps);
    expect(readFileSync(join(skillDest(cwd), "SKILL.md"), "utf8")).toBe("old");
  });
});

describe("runSetup — backend default", () => {
  it("states that connect requires an API URL + fleet key, and defaults to deploy-new on a fresh machine", async () => {
    const { deps, asked } = makeDeps(["1", "https://api", "fk", "0", "n"]);
    await runSetup(deps);
    expect(asked[0]).toMatch(/requires an API URL \+ fleet key from an operator/);
    expect(asked[0]).toMatch(/\[2\]: $/);
  });

  it("takes the deploy path when the fresh-machine default is accepted", async () => {
    const { checklistDeps } = okChecklistDeps();
    // backend(default=2), domain, region(default), 8 enters, apiUrl, fleetKey, count, github
    const answers = ["", "mail.example.com", "", "", "", "", "", "", "", "", "",
      "https://api.example", "fk", "0", "n"];
    const { deps, said } = makeDeps(answers, { checklistDeps });
    await runSetup(deps);
    expect(said.some((m) => m.includes("Clone the agent-identity repository"))).toBe(true);
  });

  it("keeps connect as the default when a fleet key is already on the machine", async () => {
    const { deps, asked, base } = makeDeps(["", "https://api", "", "0", "n"]);
    writeFleetKeyFile("existing-key", base);
    await runSetup(deps);
    expect(asked[0]).toMatch(/\[1\]: $/);
    expect(asked.join("\n")).not.toContain("Mail domain"); // stayed on the connect path
  });

  it("keeps connect as the default when an API URL is already configured", async () => {
    const { deps, asked, base } = makeDeps(["", "", "fk", "0", "n"]);
    const { writeMachineConfig } = await import("./config.js");
    writeMachineConfig({ apiUrl: "https://api.example" }, base);
    await runSetup(deps);
    expect(asked[0]).toMatch(/\[1\]: $/);
  });
});

describe("runSetup — deploy new", () => {
  it("prompts for a region, passes it to every aws verify, and re-verifies failed steps", async () => {
    const runLog: string[][] = [];
    let stsCalls = 0;
    const checklistDeps = {
      run: async (bin: string, args: string[]) => {
        runLog.push([bin, ...args]);
        if (bin === "node") return { ok: true, output: "v20.11.0" };
        if (args[0] === "sts" && ++stsCalls === 1) return { ok: false, output: "not yet" };
        return { ok: true, output: '{"Rules":[]}' };
      },
      resolveMx: async () => [{ exchange: "mx" }],
    };
    // backend=2, domain, region(default us-east-1), then enters: preflight, clone,
    // credentials (fail, retry), deploy, ses, mx, rule set, fleet key step,
    // then apiUrl, fleetKey, count=0, require=n
    const answers = ["2", "mail.example.com", "", "", "", "", "", "", "", "", "", "",
      "https://api.example", "fk", "0", "n"];
    const { deps, said } = makeDeps(answers, { checklistDeps });
    await runSetup(deps);
    expect(said.some((m) => m.includes("Preflight: required tools"))).toBe(true);
    expect(said.some((m) => m.includes("not yet"))).toBe(true);
    expect(said.some((m) => m.includes("Setup complete"))).toBe(true);
    expect(runLog).toContainEqual([
      "aws", "cloudformation", "describe-stacks", "--stack-name", "AgentIdentity",
      "--region", "us-east-1",
    ]);
  });

  it("rejects regions without SES inbound and re-prompts", async () => {
    const { runLog, checklistDeps } = okChecklistDeps();
    // extra region answer: invalid first, then us-west-2
    const answers = ["2", "mail.example.com", "eu-central-1", "us-west-2",
      "", "", "", "", "", "", "", "",
      "https://api.example", "fk", "0", "n"];
    const { deps, said } = makeDeps(answers, { checklistDeps });
    await runSetup(deps);
    expect(said.some((m) => m.includes("SES inbound"))).toBe(true);
    expect(runLog).toContainEqual([
      "aws", "cloudformation", "describe-stacks", "--stack-name", "AgentIdentity",
      "--region", "us-west-2",
    ]);
  });

  it("defaults the region from the deploy env, consistent with infra/bin/app.ts", async () => {
    const { runLog, checklistDeps } = okChecklistDeps();
    const answers = ["2", "mail.example.com", "", "", "", "", "", "", "", "", "",
      "https://api.example", "fk", "0", "n"];
    const { deps } = makeDeps(answers, { checklistDeps, env: { CDK_DEFAULT_REGION: "eu-west-1" } });
    await runSetup(deps);
    expect(runLog).toContainEqual([
      "aws", "cloudformation", "describe-stacks", "--stack-name", "AgentIdentity",
      "--region", "eu-west-1",
    ]);
  });
});
