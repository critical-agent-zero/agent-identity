import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// The checker is a plain .mjs so it can also run as a standalone CI step.
import { workflowViolations } from "../../scripts/check-workflows.mjs";

const CLEAN = `
jobs:
  deploy:
    steps:
      - name: CDK deploy
        env:
          MAIL_DOMAIN: \${{ secrets.MAIL_DOMAIN }}
          BUDGET_EMAIL: \${{ secrets.BUDGET_EMAIL }}
        run: |
          pnpm exec cdk deploy --require-approval never 2>&1 \\
            | sed -E '/^Outputs:$/d; /^AgentIdentity\\.[A-Za-z0-9]+ = /d'
`;

describe("workflowViolations", () => {
  it("passes a workflow that uses secrets and strips cdk outputs", () => {
    expect(workflowViolations(CLEAN, "clean.yml")).toEqual([]);
  });

  it("flags MAIL_DOMAIN read from a repo variable", () => {
    const bad = CLEAN.replace("\${{ secrets.MAIL_DOMAIN }}", "\${{ vars.MAIL_DOMAIN }}");
    const v = workflowViolations(bad, "bad.yml");
    expect(v.some((m: string) => /vars\.MAIL_DOMAIN/.test(m))).toBe(true);
  });

  it("flags MAIL_DOMAIN set to a literal instead of a secret", () => {
    const bad = CLEAN.replace("\${{ secrets.MAIL_DOMAIN }}", "agents.example.com");
    const v = workflowViolations(bad, "bad.yml");
    expect(v.some((m: string) => /env MAIL_DOMAIN/.test(m))).toBe(true);
  });

  it("flags BUDGET_EMAIL sourced from vars", () => {
    const bad = CLEAN.replace("\${{ secrets.BUDGET_EMAIL }}", "\${{ vars.BUDGET_EMAIL }}");
    expect(workflowViolations(bad, "bad.yml").some((m: string) => /vars\.BUDGET_EMAIL/.test(m))).toBe(true);
  });

  it("flags cdk deploy whose output is not stripped", () => {
    const bad = CLEAN.replace(/\| sed[\s\S]*$/, "");
    const v = workflowViolations(bad, "bad.yml");
    expect(v.some((m: string) => /does not strip the stack Outputs/.test(m))).toBe(true);
  });

  it("does not require an outputs strip for cdk synth", () => {
    const synth = `
jobs:
  test:
    steps:
      - run: pnpm exec cdk synth -c domain=ci.invalid > /dev/null
`;
    expect(workflowViolations(synth, "ci.yml")).toEqual([]);
  });

  it("accepts an AgentIdentity-only strip that drops the Outputs: header entirely", () => {
    const noHeader = CLEAN.replace(/\| sed[\s\S]*$/, "| grep -vE '^AgentIdentity\\.[A-Za-z0-9]+ ='\n");
    expect(workflowViolations(noHeader, "noheader.yml")).toEqual([]);
  });

  it("accepts the legacy Outputs:..Stack ARN: sed as a valid strip", () => {
    const legacy = CLEAN.replace(
      /\| sed[\s\S]*$/,
      "| sed '/^Outputs:$/,/^Stack ARN:$/{/^Stack ARN:$/!d;}'\n",
    );
    expect(workflowViolations(legacy, "legacy.yml")).toEqual([]);
  });

  it("passes every real workflow in .github/workflows (regression guard)", () => {
    const wfDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
    const files = readdirSync(wfDir).filter((f) => f.endsWith(".yml"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(workflowViolations(readFileSync(join(wfDir, f), "utf8"), f)).toEqual([]);
    }
  });
});
