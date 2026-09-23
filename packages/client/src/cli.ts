#!/usr/bin/env -S npx tsx
import { Command } from "commander";
import { stdin as input, stdout as output } from "node:process";
import * as readline from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { disableGithub, enableGithub, resolveAdminKey } from "./admin.js";
import { linkGithub, listPool, poolStatus } from "./claims.js";
import { AgentIdentityClient } from "./client.js";
import { readMachineConfig, resolveFleetKey, resolveGithubPat } from "./config.js";
import { promptAsk } from "./prompt-io.js";
import { githubApi, onboardGithubEmail } from "./github-onboard.js";
import { provisionIdentities } from "./provision.js";
import { runSetup } from "./wizard.js";

const program = new Command("agent-identity");

const fail = (message: string): void => {
  console.error(`error: ${message}`);
  process.exitCode = 1;
};

program
  .command("setup")
  .description("interactive onboarding for a consuming repo: backend, identities, .mcp.json, skill")
  .option("--skill-dir <dir>", "override the bundled skill directory (dev checkouts)")
  .action(async (opts: { skillDir?: string }) => {
    const rl = readline.createInterface({ input, output });
    try {
      await runSetup({
        io: { ask: promptAsk(rl), say: (m) => console.log(m) },
        cwd: process.cwd(),
        skillDir: opts.skillDir
          ?? join(dirname(fileURLToPath(import.meta.url)), "..", "skill"),
      });
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    } finally {
      rl.close();
    }
  });

const pool = program.command("pool").description("identity pool operations");

pool
  .command("provision")
  .description("mint identities into the machine-local pool")
  .requiredOption("--count <n>", "how many identities to mint")
  .option("--api-url <url>", "API base URL (default: machine config)")
  // No raw-secret flag: the fleet key comes from AGENT_IDENTITY_FLEET_KEY or
  // ~/.config/agent-identity/fleet_key — argv leaks into shell history and ps.
  .action(async (opts: { count: string; apiUrl?: string }) => {
    const apiUrl = opts.apiUrl ?? readMachineConfig().apiUrl ?? process.env.AGENT_IDENTITY_API_URL;
    const fleetKey = resolveFleetKey();
    if (!apiUrl) return fail("no API URL (pass --api-url or run: agent-identity setup)");
    if (!fleetKey) return fail("no fleet key (set AGENT_IDENTITY_FLEET_KEY or ~/.config/agent-identity/fleet_key, or run: agent-identity setup)");
    const count = Number.parseInt(opts.count, 10);
    if (!Number.isInteger(count) || count < 1) return fail("--count must be a positive integer");
    const results = await provisionIdentities({ count, apiUrl, fleetKey });
    for (const r of results) {
      console.log(r.error ? `failed: ${r.error}` : `minted ${r.agentId} <${r.address}>`);
    }
    const succeeded = results.filter((r) => !r.error).length;
    console.log(`${succeeded}/${count} identities provisioned`);
    if (succeeded === 0) process.exitCode = 1;
  });

pool
  .command("status")
  .description("show pool totals and free identities by capability")
  .action(() => {
    const s = poolStatus();
    console.log(`total: ${s.total}  free: ${s.free}`);
    for (const [cap, n] of Object.entries(s.freeByCapability)) {
      console.log(`free with ${cap}: ${n}`);
    }
  });

const github = program.command("github").description("GitHub account linkage");

github
  .command("link <agentId>")
  .description("record that this pool identity has a GitHub account")
  .requiredOption("--username <login>", "GitHub login of the account")
  .option("--credential-ref <ref>", "credential reference (e.g. op://...), never a raw secret")
  .action((agentId: string, opts: { username: string; credentialRef?: string }) => {
    try {
      linkGithub(agentId, {
        username: opts.username,
        ...(opts.credentialRef ? { credentialRef: opts.credentialRef } : {}),
      });
      console.log(`linked ${agentId} -> github:${opts.username}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

github
  .command("enable <agentId>")
  .description("operator: grant the github capability via the admin API and record the local GitHub link")
  .option("--api-url <url>", "API base URL (default: machine config)")
  .option("--username <login>", "GitHub login to link (default: the profile's existing link)")
  .option("--credential-ref <ref>", "credential reference (e.g. op://...), never a raw secret")
  // No raw-secret flag: the admin key comes from AGENT_IDENTITY_ADMIN_KEY or
  // ~/.config/agent-identity/admin_key — argv leaks into shell history and ps.
  // Operator-only: never export the admin key into an agent session env.
  .action(async (agentId: string, opts: { apiUrl?: string; username?: string; credentialRef?: string }) => {
    const apiUrl = opts.apiUrl ?? readMachineConfig().apiUrl ?? process.env.AGENT_IDENTITY_API_URL;
    if (!apiUrl) return fail("no API URL (pass --api-url or run: agent-identity setup)");
    const adminKey = resolveAdminKey();
    if (!adminKey) return fail("no admin key (set AGENT_IDENTITY_ADMIN_KEY or ~/.config/agent-identity/admin_key; mint one with: mailctl admin-key create)");
    try {
      const r = await enableGithub({
        agentId, apiUrl, adminKey,
        username: opts.username, credentialRef: opts.credentialRef,
      });
      console.log(`granted github capability to ${r.agentId} (capabilities: ${r.capabilities.join(", ")})`);
      console.log(`linked ${r.agentId} -> github:${r.github.username}`);
      if (r.address) {
        console.log(`If ${r.address} is not yet a verified email on ${r.github.username}, finish commit attribution with:`);
        console.log(`  agent-identity github onboard ${r.agentId}`);
      }
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

github
  .command("disable <agentId>")
  .description("operator: revoke the github capability via the admin API and remove the local link")
  .option("--api-url <url>", "API base URL (default: machine config)")
  .action(async (agentId: string, opts: { apiUrl?: string }) => {
    const apiUrl = opts.apiUrl ?? readMachineConfig().apiUrl ?? process.env.AGENT_IDENTITY_API_URL;
    if (!apiUrl) return fail("no API URL (pass --api-url or run: agent-identity setup)");
    const adminKey = resolveAdminKey();
    if (!adminKey) return fail("no admin key (set AGENT_IDENTITY_ADMIN_KEY or ~/.config/agent-identity/admin_key; mint one with: mailctl admin-key create)");
    try {
      const r = await disableGithub({ agentId, apiUrl, adminKey });
      console.log(`revoked github capability from ${r.agentId} (capabilities: ${r.capabilities.join(", ") || "none"})`);
      console.log(`removed local github link for ${r.agentId}`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

github
  .command("onboard <agentId>")
  .description("add this identity's mailbox email to the bot GitHub account for commit attribution, and surface the verification link")
  .option("--api-url <url>", "API base URL (default: machine config)")
  // No raw-secret flag: the PAT comes from AGENT_IDENTITY_GITHUB_PAT or
  // ~/.config/agent-identity/github_pat — argv leaks into shell history and ps.
  .option("--timeout <seconds>", "how long to wait for the verification email", "120")
  .action(async (agentId: string, opts: { apiUrl?: string; timeout: string }) => {
    const entry = listPool().find((p) => p.name === agentId || p.profile.agentId === agentId);
    if (!entry?.profile.address) return fail(`no pool identity ${agentId} with a mailbox address`);
    const apiUrl = opts.apiUrl ?? readMachineConfig().apiUrl ?? process.env.AGENT_IDENTITY_API_URL;
    if (!apiUrl) return fail("no API URL (pass --api-url or run: agent-identity setup)");
    const pat = resolveGithubPat();
    if (!pat) return fail("no GitHub PAT (set AGENT_IDENTITY_GITHUB_PAT or ~/.config/agent-identity/github_pat)");
    const address = entry.profile.address;
    const timeoutSeconds = Number.parseInt(opts.timeout, 10) || 120;
    const client = new AgentIdentityClient({ apiUrl, keypair: entry.profile });
    try {
      const r = await onboardGithubEmail({ address, api: githubApi(pat), mailbox: client, timeoutSeconds });
      if (r.status === "already-verified") {
        console.log(`${address} is already verified on ${r.login} — commits by ${agentId} already link to it.`);
      } else if (r.status === "no-verification-email") {
        console.log(`Added ${address} to ${r.login}, but no verification email arrived within ${timeoutSeconds}s.`);
        console.log(`Re-run to retry, or resend it from GitHub > Settings > Emails for that address.`);
      } else {
        console.log(`Added ${address} to ${r.login}. Finish by opening this link in a browser SIGNED IN AS ${r.login}:`);
        console.log(`  ${r.verificationLink}`);
        console.log("");
        console.log(`SECURITY: do this in a dedicated onboarding session. A browser signed in as ${r.login} has FULL`);
        console.log("account access — far beyond the scoped proxy — so never carry that session into everyday worker");
        console.log("agents. Onboarding is a one-time bootstrap, not an everyday capability.");
      }
      console.log(`(Proxy capability is separate: run  mailctl agent tag ${agentId} github  if not already done.)`);
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err));
    }
  });

await program.parseAsync();
