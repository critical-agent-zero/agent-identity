import {
  DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  fingerprint, generateKeypair, isValidMailboxSlug, type Keypair,
} from "@agent-identity/shared";
import { createHash, randomBytes } from "node:crypto";

export async function createFleetKey(
  ddb: DynamoDBDocumentClient, table: string, label: string,
): Promise<string> {
  const key = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(key).digest("hex");
  await ddb.send(new PutCommand({
    TableName: table,
    Item: { PK: `FLEET#${hash}`, SK: "FLEET", label, createdAt: new Date().toISOString() },
  }));
  return key;
}

// ADMINKEY# is deliberately a separate namespace from FLEET#: agents hold
// fleet keys for auto-provisioning and must never be able to use one to
// grant capabilities.
export async function createAdminKey(
  ddb: DynamoDBDocumentClient, table: string, label: string,
): Promise<string> {
  const key = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(key).digest("hex");
  await ddb.send(new PutCommand({
    TableName: table,
    Item: { PK: `ADMINKEY#${hash}`, SK: "ADMINKEY", label, createdAt: new Date().toISOString() },
  }));
  return key;
}

/** Read-only dashboard credential: only ever checked on GET /fleet routes,
 *  stored hashed like the fleet key but in its own VIEWER partition so the
 *  credential classes can never stand in for each other. */
export async function createViewerKey(
  ddb: DynamoDBDocumentClient, table: string, label: string,
): Promise<string> {
  const key = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(key).digest("hex");
  await ddb.send(new PutCommand({
    TableName: table,
    Item: { PK: `VIEWER#${hash}`, SK: "VIEWER", label, createdAt: new Date().toISOString() },
  }));
  return key;
}

export interface MailboxResult {
  address: string;
  fingerprint: string;
  keypair: Keypair;
}

/** Mint a named operator mailbox (issue #114): an identity whose local-part
 *  is an operator-chosen slug, carrying a strict sender allowlist and an
 *  optional domain catch-all. Writes the ADDR mirror (keyed by the slug) and
 *  the AGENT record (marked `mailbox: true`) in one transaction; the caller
 *  persists the returned keypair as the claimable pool profile. The private
 *  key never touches DynamoDB. The slug is validated (and can never be a
 *  6-digit numeric, so it cannot collide with a pool agentId), and both puts
 *  are conditional so an existing identity is never clobbered. */
export async function createMailbox(
  ddb: DynamoDBDocumentClient, table: string, domain: string,
  name: string, allowlist: string[], catchAll: boolean,
): Promise<MailboxResult> {
  if (!isValidMailboxSlug(name)) {
    throw new Error(
      `invalid mailbox slug "${name}": must match ^[a-z][a-z0-9-]{1,30}$ and not be a 6-digit numeric`,
    );
  }
  const existing = await ddb.send(new GetCommand({
    TableName: table, Key: { PK: `ADDR#${name}`, SK: "ADDR" },
  }));
  if (existing.Item) throw new Error(`local-part "${name}" already exists (identity or mailbox)`);

  const keypair = generateKeypair();
  const fp = fingerprint(keypair.publicKeySpkiBase64);
  const address = `${name}@${domain}`;
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      { Put: {
        TableName: table,
        Item: { PK: `ADDR#${name}`, SK: "ADDR", fingerprint: fp },
        ConditionExpression: "attribute_not_exists(PK)",
      }},
      { Put: {
        TableName: table,
        Item: {
          PK: `AGENT#${fp}`, SK: "AGENT", agentId: name, address,
          publicKey: keypair.publicKeySpkiBase64, status: "active",
          createdAt: new Date().toISOString(),
          mailbox: true, allowlist, catchAll,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }},
    ],
  }));
  return { address, fingerprint: fp, keypair };
}

export interface AgentRow {
  fingerprint: string;
  agentId: string;
  address: string;
  status: string;
  capabilities: string;
}

export async function listAgents(
  ddb: DynamoDBDocumentClient, table: string,
): Promise<AgentRow[]> {
  const res = await ddb.send(new ScanCommand({
    TableName: table,
    FilterExpression: "SK = :sk",
    ExpressionAttributeValues: { ":sk": "AGENT" },
  }));
  return (res.Items ?? []).map((i) => ({
    fingerprint: (i.PK as string).slice("AGENT#".length),
    agentId: i.agentId as string,
    address: i.address as string,
    status: i.status as string,
    capabilities: ((i.capabilities as string[]) ?? []).join(","),
  }));
}

async function agentKeyByLocalPart(
  ddb: DynamoDBDocumentClient, table: string, agentId: string,
): Promise<{ PK: string; SK: string }> {
  const { Item } = await ddb.send(new GetCommand({
    TableName: table, Key: { PK: `ADDR#${agentId}`, SK: "ADDR" },
  }));
  if (!Item) throw new Error(`no agent with id ${agentId}`);
  return { PK: `AGENT#${Item.fingerprint}`, SK: "AGENT" };
}

export async function revokeAgent(
  ddb: DynamoDBDocumentClient, table: string, agentId: string,
): Promise<void> {
  const key = await agentKeyByLocalPart(ddb, table, agentId);
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: "SET #s = :r",
    ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":r": "revoked" },
  }));
}

async function setCapabilities(
  ddb: DynamoDBDocumentClient, table: string, agentId: string,
  mutate: (caps: Set<string>) => void,
): Promise<void> {
  const key = await agentKeyByLocalPart(ddb, table, agentId);
  const { Item } = await ddb.send(new GetCommand({ TableName: table, Key: key }));
  const caps = new Set<string>((Item?.capabilities as string[]) ?? []);
  mutate(caps);
  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: "SET capabilities = :c",
    ExpressionAttributeValues: { ":c": [...caps].sort() },
  }));
}

export function tagAgent(
  ddb: DynamoDBDocumentClient, table: string, agentId: string, capability: string,
): Promise<void> {
  return setCapabilities(ddb, table, agentId, (caps) => caps.add(capability));
}

export function untagAgent(
  ddb: DynamoDBDocumentClient, table: string, agentId: string, capability: string,
): Promise<void> {
  return setCapabilities(ddb, table, agentId, (caps) => caps.delete(capability));
}
