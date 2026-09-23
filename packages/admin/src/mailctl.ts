#!/usr/bin/env -S npx tsx
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Command } from "commander";
import { createAdminKey, createFleetKey, createViewerKey, listAgents, revokeAgent, tagAgent, untagAgent } from "./commands.js";

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
