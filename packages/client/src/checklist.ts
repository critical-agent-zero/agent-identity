import { execFile } from "node:child_process";
import { resolveMx as dnsResolveMx } from "node:dns/promises";

export type RunCmd = (bin: string, args: string[]) => Promise<{ ok: boolean; output: string }>;

export interface ChecklistDeps {
  run: RunCmd;
  resolveMx: (domain: string) => Promise<Array<{ exchange: string }>>;
}

export interface ChecklistContext {
  domain: string;
}

export interface ChecklistStep {
  title: string;
  /** Printed verbatim; contains the exact commands the operator runs. */
  instructions: string;
  /** Returns an error message, or undefined when the step is verified. */
  verify?: (deps: ChecklistDeps, ctx: ChecklistContext) => Promise<string | undefined>;
}

/** SES inbound (email receiving) only exists in these regions. */
export const SES_INBOUND_REGIONS: readonly string[] = ["us-east-1", "us-west-2", "eu-west-1"];

/** Same precedence as infra/bin/app.ts; env regions without SES inbound are ignored. */
export function defaultDeployRegion(
  env: Record<string, string | undefined> = process.env,
): string {
  const candidate = env.CDK_DEFAULT_REGION || env.AWS_REGION;
  return candidate && SES_INBOUND_REGIONS.includes(candidate) ? candidate : "us-east-1";
}

export function defaultChecklistDeps(): ChecklistDeps {
  return {
    run: (bin, args) =>
      new Promise((resolve) => {
        execFile(bin, args, (err, stdout, stderr) => {
          resolve({ ok: !err, output: err ? `${stdout}${stderr}`.trim() : stdout.trim() });
        });
      }),
    resolveMx: dnsResolveMx,
  };
}

/** All aws commands carry --region so verification hits the stack's region, not the ambient one. */
export function deployChecklist(region: string): ChecklistStep[] {
  const aws = (run: RunCmd, args: string[]) => run("aws", [...args, "--region", region]);
  return [
    {
      title: "Preflight: required tools",
      instructions:
        "I'll check the tools the deploy needs: aws CLI, node >= 20, pnpm.",
      verify: async ({ run }) => {
        const missing: string[] = [];
        if (!(await run("aws", ["--version"])).ok) {
          missing.push("aws CLI (https://aws.amazon.com/cli/)");
        }
        const node = await run("node", ["--version"]);
        const major = Number.parseInt(node.output.trim().replace(/^v/, ""), 10);
        if (!node.ok) missing.push("node >= 20");
        else if (!(major >= 20)) missing.push(`node >= 20 (found ${node.output.trim()})`);
        if (!(await run("pnpm", ["--version"])).ok) {
          missing.push("pnpm (npm install -g pnpm)");
        }
        return missing.length ? `missing required tools: ${missing.join(", ")}` : undefined;
      },
    },
    {
      title: "Clone the agent-identity repository",
      instructions:
        "The CDK stack and mailctl are not published to npm, so deploying uses a source checkout:\n" +
        "  git clone https://github.com/critical-labs/agent-identity.git && cd agent-identity && pnpm install",
    },
    {
      title: "AWS credentials",
      instructions:
        "Log in with credentials for the target account:\n" +
        "  aws configure   # or aws sso login / your usual method",
      verify: async ({ run }) => {
        const r = await aws(run, ["sts", "get-caller-identity"]);
        return r.ok ? undefined : `aws sts get-caller-identity failed: ${r.output}`;
      },
    },
    {
      title: "CDK bootstrap and deploy",
      instructions:
        "From the cloned repo:\n" +
        `  npx aws-cdk@2 bootstrap aws://$(aws sts get-caller-identity --query Account --output text)/${region}\n` +
        `  cd infra && CDK_DEFAULT_REGION=${region} npx cdk deploy -c domain=<your mail domain>\n` +
        "Note the ApiUrl, MxRecord, TableName, and ReceiptRuleSetName outputs.",
      verify: async ({ run }) => {
        const r = await aws(run, ["cloudformation", "describe-stacks", "--stack-name", "AgentIdentity"]);
        return r.ok ? undefined : `stack AgentIdentity not found in ${region}: ${r.output}`;
      },
    },
    {
      title: "SES domain identity and DNS verification records",
      instructions:
        "Create the SES email identity and publish its DKIM/verification DNS records:\n" +
        `  aws sesv2 create-email-identity --email-identity <your mail domain> --region ${region}`,
      verify: async ({ run }, { domain }) => {
        const r = await aws(run, ["sesv2", "get-email-identity", "--email-identity", domain]);
        return r.ok ? undefined : `SES identity for ${domain} not found in ${region}: ${r.output}`;
      },
    },
    {
      title: "MX record",
      instructions:
        "Publish an MX record for your mail domain pointing at the stack's MxRecord output.",
      verify: async ({ resolveMx }, { domain }) => {
        try {
          const records = await resolveMx(domain);
          return records.length > 0 ? undefined : `no MX record found for ${domain}`;
        } catch (err) {
          return `MX lookup for ${domain} failed: ${(err as Error).message}`;
        }
      },
    },
    {
      title: "Activate the SES receipt rule set",
      instructions:
        `  aws ses set-active-receipt-rule-set --rule-set-name <ReceiptRuleSetName output> --region ${region}`,
      verify: async ({ run }) => {
        const r = await aws(run, ["ses", "describe-active-receipt-rule-set"]);
        if (!r.ok) return `describe-active-receipt-rule-set failed: ${r.output}`;
        return r.output.includes("Rules") ? undefined : "no active receipt rule set";
      },
    },
    {
      title: "Mint a fleet key",
      instructions:
        "From the cloned repo:\n" +
        "  AGENT_IDENTITY_TABLE=<TableName output> npx tsx packages/admin/src/mailctl.ts fleet-key create --label setup\n" +
        "You will paste the key at the next prompt (it is stored at ~/.config/agent-identity/fleet_key).",
    },
  ];
}
