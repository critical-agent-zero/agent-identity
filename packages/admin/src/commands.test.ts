import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { fingerprint } from "@agent-identity/shared";
import { mockClient } from "aws-sdk-client-mock";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createAdminKey, createFleetKey, createMailbox, createViewerKey, listAgents, revokeAgent, tagAgent, untagAgent } from "./commands.js";

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());

describe("mailctl commands", () => {
  it("createFleetKey stores only the sha256 hash and returns the secret once", async () => {
    ddb.on(PutCommand).resolves({});
    const key = await createFleetKey(ddb as never, "tbl", "ci");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe(`FLEET#${createHash("sha256").update(key).digest("hex")}`);
    expect(JSON.stringify(item)).not.toContain(key);
    expect(item.label).toBe("ci");
  });

  it("createAdminKey stores only the sha256 hash under ADMINKEY# and returns the secret once", async () => {
    ddb.on(PutCommand).resolves({});
    const key = await createAdminKey(ddb as never, "tbl", "ops");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe(`ADMINKEY#${createHash("sha256").update(key).digest("hex")}`);
    expect(item.SK).toBe("ADMINKEY");
    expect(JSON.stringify(item)).not.toContain(key);
    expect(item.label).toBe("ops");
  });

  it("admin keys and fleet keys land in distinct namespaces", async () => {
    ddb.on(PutCommand).resolves({});
    await createFleetKey(ddb as never, "tbl", "x");
    await createAdminKey(ddb as never, "tbl", "x");
    const [fleet, admin] = ddb.commandCalls(PutCommand).map((c) => c.args[0].input.Item!);
    expect(fleet.PK).toMatch(/^FLEET#/);
    expect(admin.PK).toMatch(/^ADMINKEY#/);
    expect(fleet.SK).not.toBe(admin.SK);
  });

  it("createViewerKey stores only the sha256 hash under the VIEWER partition", async () => {
    ddb.on(PutCommand).resolves({});
    const key = await createViewerKey(ddb as never, "tbl", "dashboard");
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe(`VIEWER#${createHash("sha256").update(key).digest("hex")}`);
    expect(item.SK).toBe("VIEWER");
    expect(JSON.stringify(item)).not.toContain(key);
    expect(item.label).toBe("dashboard");
  });

  it("listAgents scans AGENT records", async () => {
    ddb.on(ScanCommand).resolves({
      Items: [{ PK: "AGENT#fp1", agentId: "482913", address: "482913@d", status: "active" }],
    });
    const agents = await listAgents(ddb as never, "tbl");
    expect(agents).toEqual([
      { fingerprint: "fp1", agentId: "482913", address: "482913@d", status: "active", capabilities: "" },
    ]);
  });

  it("revokeAgent resolves agentId via ADDR mirror and sets revoked", async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: "ADDR#482913", SK: "ADDR", fingerprint: "fp1" } });
    ddb.on(UpdateCommand).resolves({});
    await revokeAgent(ddb as never, "tbl", "482913");
    const get = ddb.commandCalls(GetCommand)[0].args[0].input;
    expect(get.Key).toEqual({ PK: "ADDR#482913", SK: "ADDR" });
    const upd = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.Key).toEqual({ PK: "AGENT#fp1", SK: "AGENT" });
  });

  it("revokeAgent throws on unknown agentId", async () => {
    ddb.on(GetCommand).resolves({});
    await expect(revokeAgent(ddb as never, "tbl", "000000")).rejects.toThrow(/no agent/);
  });
});

describe("createMailbox", () => {
  it("mints a keypair and writes ADDR + AGENT rows for the slug", async () => {
    ddb.on(GetCommand).resolves({}); // no collision
    ddb.on(TransactWriteCommand).resolves({});
    const res = await createMailbox(ddb as never, "tbl", "mail.example.com", "ops",
      ["alerts@status.example", "*@github.com"], true);

    expect(res.address).toBe("ops@mail.example.com");
    expect(res.keypair.privateKeyPem).toContain("PRIVATE KEY");
    expect(res.keypair.publicKeySpkiBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
    expect(res.fingerprint).toBe(fingerprint(res.keypair.publicKeySpkiBase64));

    const tx = ddb.commandCalls(TransactWriteCommand)[0].args[0].input;
    const items = tx.TransactItems!.map((t) => t.Put!.Item!);
    const addr = items.find((i) => (i.PK as string).startsWith("ADDR#"))!;
    const agent = items.find((i) => (i.PK as string).startsWith("AGENT#"))!;

    expect(addr.PK).toBe("ADDR#ops");
    expect(addr.SK).toBe("ADDR");
    expect(addr.fingerprint).toBe(res.fingerprint);

    expect(agent.PK).toBe(`AGENT#${res.fingerprint}`);
    expect(agent.SK).toBe("AGENT");
    expect(agent.agentId).toBe("ops");
    expect(agent.address).toBe("ops@mail.example.com");
    expect(agent.status).toBe("active");
    expect(agent.mailbox).toBe(true);
    expect(agent.catchAll).toBe(true);
    expect(agent.allowlist).toEqual(["alerts@status.example", "*@github.com"]);
    expect(agent.publicKey).toBe(res.keypair.publicKeySpkiBase64);

    // Both puts guard against clobbering an existing identity.
    for (const t of tx.TransactItems!) {
      expect(t.Put!.ConditionExpression).toContain("attribute_not_exists");
    }
    // The private key is never written to the table.
    expect(JSON.stringify(tx)).not.toContain(res.keypair.privateKeyPem);
  });

  it("stores catchAll=false when the flag is not set", async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    const res = await createMailbox(ddb as never, "tbl", "mail.example.com", "ops", ["*@github.com"], false);
    const agent = ddb.commandCalls(TransactWriteCommand)[0].args[0].input
      .TransactItems!.map((t) => t.Put!.Item!).find((i) => (i.PK as string).startsWith("AGENT#"))!;
    expect(agent.catchAll).toBe(false);
    expect(res.address).toBe("ops@mail.example.com");
  });

  it("rejects an invalid slug without writing", async () => {
    await expect(createMailbox(ddb as never, "tbl", "d", "Ops", ["*@github.com"], false))
      .rejects.toThrow(/slug/i);
    await expect(createMailbox(ddb as never, "tbl", "d", "1ops", [], false))
      .rejects.toThrow(/slug/i);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("rejects a 6-digit numeric slug (pool agentId collision)", async () => {
    await expect(createMailbox(ddb as never, "tbl", "d", "482913", [], false))
      .rejects.toThrow(/slug/i);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it("rejects a collision with an existing identity", async () => {
    ddb.on(GetCommand, { Key: { PK: "ADDR#ops", SK: "ADDR" } })
      .resolves({ Item: { PK: "ADDR#ops", SK: "ADDR", fingerprint: "existing" } });
    await expect(createMailbox(ddb as never, "tbl", "d", "ops", ["*@github.com"], false))
      .rejects.toThrow(/exists|collision|taken/i);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe("tagAgent / untagAgent", () => {
  it("tagAgent adds a capability (deduped, sorted)", async () => {
    ddb.on(GetCommand, { Key: { PK: "ADDR#482913", SK: "ADDR" } })
      .resolves({ Item: { PK: "ADDR#482913", SK: "ADDR", fingerprint: "fp1" } });
    ddb.on(GetCommand, { Key: { PK: "AGENT#fp1", SK: "AGENT" } })
      .resolves({ Item: { PK: "AGENT#fp1", agentId: "482913", capabilities: ["email"] } });
    ddb.on(UpdateCommand).resolves({});
    await tagAgent(ddb as never, "tbl", "482913", "github");
    const upd = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.Key).toEqual({ PK: "AGENT#fp1", SK: "AGENT" });
    expect(upd.ExpressionAttributeValues).toEqual({ ":c": ["email", "github"] });
  });

  it("tagAgent is idempotent", async () => {
    ddb.on(GetCommand, { Key: { PK: "ADDR#482913", SK: "ADDR" } })
      .resolves({ Item: { PK: "ADDR#482913", SK: "ADDR", fingerprint: "fp1" } });
    ddb.on(GetCommand, { Key: { PK: "AGENT#fp1", SK: "AGENT" } })
      .resolves({ Item: { PK: "AGENT#fp1", agentId: "482913", capabilities: ["github"] } });
    ddb.on(UpdateCommand).resolves({});
    await tagAgent(ddb as never, "tbl", "482913", "github");
    const upd = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.ExpressionAttributeValues).toEqual({ ":c": ["github"] });
  });

  it("untagAgent removes a capability", async () => {
    ddb.on(GetCommand, { Key: { PK: "ADDR#482913", SK: "ADDR" } })
      .resolves({ Item: { PK: "ADDR#482913", SK: "ADDR", fingerprint: "fp1" } });
    ddb.on(GetCommand, { Key: { PK: "AGENT#fp1", SK: "AGENT" } })
      .resolves({ Item: { PK: "AGENT#fp1", agentId: "482913", capabilities: ["email", "github"] } });
    ddb.on(UpdateCommand).resolves({});
    await untagAgent(ddb as never, "tbl", "482913", "github");
    const upd = ddb.commandCalls(UpdateCommand)[0].args[0].input;
    expect(upd.ExpressionAttributeValues).toEqual({ ":c": ["email"] });
  });

  it("throws for an unknown agentId", async () => {
    ddb.on(GetCommand).resolves({});
    await expect(tagAgent(ddb as never, "tbl", "000000", "github"))
      .rejects.toThrow(/no agent with id 000000/);
  });
});
