import type { AgentIdentity } from "@agent-identity/shared";
import {
  DynamoDBDocumentClient, GetCommand, TransactWriteCommand, UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomInt } from "node:crypto";

export interface AgentRecord extends AgentIdentity {
  publicKey: string;
  status: "active" | "revoked";
  createdAt: string;
  // Operator-set (admin route / mailctl), or granted at identity BIRTH by the
  // deployment's AUTO_CAPABILITIES policy. Re-registration never touches it.
  capabilities?: string[];
}

/** What register() resolved: the identity, its stored capabilities, and
 *  whether THIS call created the record. `created` lets the API write the
 *  birth-only ledger event without a second read — and is what confines
 *  policy grants to birth: an existing record comes back as-is. */
export interface RegistrationResult extends AgentIdentity {
  capabilities: string[];
  created: boolean;
}

export class AgentsRepo {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly domain: string,
  ) {}

  async getByFingerprint(fp: string): Promise<AgentRecord | undefined> {
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `AGENT#${fp}`, SK: "AGENT" },
    }));
    return Item as AgentRecord | undefined;
  }

  async getByLocalPart(agentId: string): Promise<AgentRecord | undefined> {
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `ADDR#${agentId}`, SK: "ADDR" },
    }));
    if (!Item) return undefined;
    return this.getByFingerprint(Item.fingerprint as string);
  }

  /** Idempotent registration. `birthCapabilities` (already policy-filtered
   *  and shape-validated by the caller) are written ONLY when this call
   *  creates the record: an existing agent re-registering gets its existing
   *  record back untouched, so re-registration can never self-escalate. */
  async register(
    publicKeySpkiBase64: string, fp: string, birthCapabilities: string[] = [],
  ): Promise<RegistrationResult> {
    const asResult = (a: AgentRecord): RegistrationResult => ({
      agentId: a.agentId, address: a.address,
      capabilities: a.capabilities ?? [], created: false,
    });
    const existing = await this.getByFingerprint(fp);
    if (existing) return asResult(existing);

    const granted = [...new Set(birthCapabilities)].sort();
    for (let attempt = 0; attempt < 5; attempt++) {
      const agentId = String(randomInt(100000, 1000000));
      const address = `${agentId}@${this.domain}`;
      try {
        await this.ddb.send(new TransactWriteCommand({
          TransactItems: [
            { Put: {
              TableName: this.table,
              Item: { PK: `ADDR#${agentId}`, SK: "ADDR", fingerprint: fp },
              ConditionExpression: "attribute_not_exists(PK)",
            }},
            { Put: {
              TableName: this.table,
              Item: {
                PK: `AGENT#${fp}`, SK: "AGENT", agentId, address,
                publicKey: publicKeySpkiBase64, status: "active",
                createdAt: new Date().toISOString(),
                ...(granted.length > 0 ? { capabilities: granted } : {}),
              },
              ConditionExpression: "attribute_not_exists(PK)",
            }},
          ],
        }));
        return { agentId, address, capabilities: granted, created: true };
      } catch (err) {
        if ((err as Error).name !== "TransactionCanceledException") throw err;
        // Either addr collision (retry new id) or concurrent register of the
        // same key (return what won — created:false, so no double ledger event).
        const winner = await this.getByFingerprint(fp);
        if (winner) return asResult(winner);
      }
    }
    throw new Error("could not allocate agent id after 5 attempts");
  }

  async verifyFleetKey(fleetKey: string): Promise<boolean> {
    const hash = createHash("sha256").update(fleetKey).digest("hex");
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `FLEET#${hash}`, SK: "FLEET" },
    }));
    return Item !== undefined;
  }

  // ADMINKEY# is a namespace distinct from FLEET#: a fleet key (held by
  // agents for auto-provisioning) can never satisfy an admin-key lookup.
  async verifyAdminKey(adminKey: string): Promise<boolean> {
    const hash = createHash("sha256").update(adminKey).digest("hex");
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `ADMINKEY#${hash}`, SK: "ADMINKEY" },
    }));
    return Item !== undefined;
  }

  /** Viewer keys are a separate, read-only credential class: they live in
   *  their own VIEWER partition (hashed at rest like the fleet key), so a
   *  fleet key can never pass as a viewer key or vice versa. Only the GET
   *  /fleet routes ever check this. */
  async verifyViewerKey(viewerKey: string): Promise<boolean> {
    const hash = createHash("sha256").update(viewerKey).digest("hex");
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `VIEWER#${hash}`, SK: "VIEWER" },
    }));
    return Item !== undefined;
  }

  private async setCapabilities(
    agentId: string, mutate: (caps: Set<string>) => void,
  ): Promise<string[] | undefined> {
    const { Item: mirror } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `ADDR#${agentId}`, SK: "ADDR" },
    }));
    if (!mirror) return undefined;
    const key = { PK: `AGENT#${mirror.fingerprint as string}`, SK: "AGENT" };
    const { Item } = await this.ddb.send(new GetCommand({ TableName: this.table, Key: key }));
    if (!Item) return undefined;
    const caps = new Set<string>((Item.capabilities as string[]) ?? []);
    mutate(caps);
    const sorted = [...caps].sort();
    await this.ddb.send(new UpdateCommand({
      TableName: this.table,
      Key: key,
      UpdateExpression: "SET capabilities = :c",
      ExpressionAttributeValues: { ":c": sorted },
    }));
    return sorted;
  }

  addCapability(agentId: string, capability: string): Promise<string[] | undefined> {
    return this.setCapabilities(agentId, (caps) => caps.add(capability));
  }

  removeCapability(agentId: string, capability: string): Promise<string[] | undefined> {
    return this.setCapabilities(agentId, (caps) => caps.delete(capability));
  }


  async revoke(fp: string): Promise<void> {
    await this.ddb.send(new UpdateCommand({
      TableName: this.table,
      Key: { PK: `AGENT#${fp}`, SK: "AGENT" },
      UpdateExpression: "SET #s = :r",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":r": "revoked" },
    }));
  }
}
