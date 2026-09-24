#!/usr/bin/env -S npx tsx
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { poolDir, savePoolProfile } from "@agent-identity/client";
import { Command } from "commander";
import { join } from "node:path";
import { createAdminKey, createFleetKey, createMailbox, createViewerKey, listAgents, revokeAgent, tagAgent, untagAgent } from "./commands.js";

const table = process.env.AGENT_IDENTITY_TABLE;
if (!table) {
  console.error("Set AGENT_IDENTITY_TABLE (DynamoDB table name)");
  process.exit(1);
}
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const program = new Command("mailctl");

program.command("fleet-key")
  .command("create")
  .option("--label <label>", "label for this key", "default")
  .action(async (opts: { label: string }) => {
    const key = await createFleetKey(ddb, table, opts.label);
    console.log("Fleet key (shown once, store it now):");
    console.log(key);
  });

program.command("admin-key")
  .description("operator-only key gating capability admin over the API; never export it into an agent session env")
  .command("create")
  .option("--label <label>", "label for this key", "default")
  .action(async (opts: { label: string }) => {
    const key = await createAdminKey(ddb, table, opts.label);
    console.log("Admin key (shown once, store it now):");
    console.log(key);
    console.log("Operator-only: put it in AGENT_IDENTITY_ADMIN_KEY or ~/.config/agent-identity/admin_key (0600).");
    console.log("Never export it into an agent session env — it grants capability admin over every identity.");
    console.log("Note: agent sessions running as the same OS user can read that file (0600 does not stop them).");
    console.log("On machines that run agents, prefer the env var in an operator-only shell or a separate operator OS user.");
  });

program.command("viewer-key")
  .command("create")
  .option("--label <label>", "label for this key", "default")
  .action(async (opts: { label: string }) => {
    const key = await createViewerKey(ddb, table, opts.label);
    console.log("Viewer key (read-only fleet dashboard access; shown once, store it now):");
    console.log(key);
  });

// Named operator mailbox (issue #114): a stable receive-only address whose
// delivery is gated on a strict sender allowlist AND positive authentication.
program.command("mailbox")
  .command("create <name>")
  .description("mint a named operator mailbox (slug local-part) with a strict sender allowlist")
  .requiredOption("--allow <list>", "comma-separated allowlist of exact addresses and *@domain patterns")
  .option("--catch-all", "also route unknown local-parts at the domain into this mailbox", false)
  .option("--domain <domain>", "mail domain (defaults to MAIL_DOMAIN)", process.env.MAIL_DOMAIN)
  .action(async (name: string, opts: { allow: string; catchAll: boolean; domain?: string }) => {
    if (!opts.domain) {
      console.error("Set --domain or MAIL_DOMAIN (the mail domain, e.g. mail.example.com)");
      process.exit(1);
    }
    const allowlist = opts.allow.split(",").map((s) => s.trim()).filter(Boolean);
    if (allowlist.length === 0) {
      console.error("--allow must list at least one address or *@domain pattern");
      process.exit(1);
    }
    const { address, keypair } = await createMailbox(
      ddb, table, opts.domain, name, allowlist, opts.catchAll,
    );
    // Write the claimable pool profile so an orchestration agent can claim it.
    savePoolProfile({ ...keypair, agentId: name, address });
    console.log(`Mailbox created: ${address}`);
    console.log(`  allowlist:  ${allowlist.join(", ")}`);
    console.log(`  catch-all:  ${opts.catchAll ? "yes (unknown local-parts route here)" : "no"}`);
    console.log(`  profile:    ${join(poolDir(), `${name}.json`)}`);
  });

const agent = program.command("agent");
agent.command("list").action(async () => {
  console.table(await listAgents(ddb, table));
});
agent.command("revoke <agentId>").action(async (agentId: string) => {
  await revokeAgent(ddb, table, agentId);
  console.log(`revoked ${agentId}`);
});
agent.command("tag <agentId> <capability>").action(async (agentId: string, capability: string) => {
  await tagAgent(ddb, table, agentId, capability);
  console.log(`tagged ${agentId} +${capability}`);
});
agent.command("untag <agentId> <capability>").action(async (agentId: string, capability: string) => {
  await untagAgent(ddb, table, agentId, capability);
  console.log(`untagged ${agentId} -${capability}`);
});

await program.parseAsync();
