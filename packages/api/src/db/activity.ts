import {
  ulid,
  type ActivityEvent, type AgentStatus, type AgentStatusView,
} from "@agent-identity/shared";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { InvalidCursorError } from "./emails.js";

// A status older than this reads as stale; freshness is computed at read
// time, so no TTL delete is needed and the last-known status stays visible.
export const STATUS_FRESH_MS = 30 * 60_000;

// Fleet feed bounds: the feed is assembled by scanning agent partitions, so
// the response size must be capped server-side.
const FLEET_FEED_DEFAULT = 50;
const FLEET_FEED_MAX = 200;

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString());
  } catch {
    throw new InvalidCursorError("malformed cursor");
  }
}

// Allowlist mapping: only ActivityEvent fields ever leave the repo, so stray
// storage attributes (keys, TTLs, anything written by mistake) cannot leak
// into any feed.
function toEvent(item: Record<string, unknown>): ActivityEvent {
  return {
    agentId: item.agentId as string,
    ts: item.ts as string,
    class: item.class as ActivityEvent["class"],
    type: item.type as ActivityEvent["type"],
    summary: item.summary as string,
    ...(item.detail !== undefined ? { detail: item.detail as ActivityEvent["detail"] } : {}),
    ...(item.ref !== undefined ? { ref: item.ref as string } : {}),
  };
}

function statusView(item: Record<string, unknown>, now: number): AgentStatusView {
  const updatedAt = item.updatedAt as string;
  return {
    state: item.state as AgentStatus["state"],
    ...(item.label !== undefined ? { label: item.label as string } : {}),
    updatedAt,
    stale: now - Date.parse(updatedAt) > STATUS_FRESH_MS,
  };
}

export interface FleetAgent {
  agentId: string;
  capabilities: string[];
  status?: AgentStatusView;
  counts: { attested: number; claimed: number };
}

export class ActivityRepo {
  constructor(
    private readonly ddb: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly claimedRetentionDays: number = 90,
  ) {}

  /** Append one event. Claimed events expire (~claimedRetentionDays);
   *  attested events are the permanent record and never carry a TTL. */
  async putEvent(event: ActivityEvent): Promise<string> {
    const ms = Date.parse(event.ts);
    const id = `${event.ts}#${ulid(ms)}`;
    const ttl = event.class === "claimed"
      ? { expiresAt: Math.floor(ms / 1000) + this.claimedRetentionDays * 24 * 3600 }
      : {};
    await this.ddb.send(new PutCommand({
      TableName: this.table,
      Item: { PK: `AGENT#${event.agentId}`, SK: `ACT#${id}`, ...ttl, ...event },
    }));
    return id;
  }

  /** One agent's feed, newest first, cursor pagination like listEmails. */
  async listEvents(
    agentId: string,
    opts: { limit?: number; cursor?: string },
  ): Promise<{ events: ActivityEvent[]; cursor?: string }> {
    const res = await this.ddb.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :pfx)",
      ExpressionAttributeValues: { ":pk": `AGENT#${agentId}`, ":pfx": "ACT#" },
      ScanIndexForward: false,
      Limit: opts.limit ?? 25,
      ExclusiveStartKey: opts.cursor ? decodeCursor(opts.cursor) : undefined,
    }));
    return {
      events: (res.Items ?? []).map(toEvent),
      cursor: res.LastEvaluatedKey
        ? Buffer.from(JSON.stringify(res.LastEvaluatedKey)).toString("base64url")
        : undefined,
    };
  }

  /** Overwrite the agent's single STATUS row. */
  async setStatus(agentId: string, status: AgentStatus): Promise<void> {
    await this.ddb.send(new PutCommand({
      TableName: this.table,
      Item: { PK: `AGENT#${agentId}`, SK: "STATUS", ...status },
    }));
  }

  async getStatus(agentId: string, now: number = Date.now()): Promise<AgentStatusView | undefined> {
    const { Item } = await this.ddb.send(new GetCommand({
      TableName: this.table, Key: { PK: `AGENT#${agentId}`, SK: "STATUS" },
    }));
    if (!Item) return undefined;
    return statusView(Item, now);
  }

  /** Fleet-wide feed, newest first. Assembled by scanning the ACT rows of
   *  every agent partition and merging in memory — fine at fleet sizes this
   *  table serves; a busy multi-tenant deployment would add a GSI. */
  async listFleetEvents(opts: { limit?: number } = {}): Promise<{ events: ActivityEvent[] }> {
    const limit = Math.min(opts.limit ?? FLEET_FEED_DEFAULT, FLEET_FEED_MAX);
    const items = await this.scanAll(
      "begins_with(SK, :act)", { ":act": "ACT#" },
    );
    // SK is ACT#<iso-ts>#<ulid>: lexicographic order is time order.
    items.sort((a, b) => ((a.SK as string) < (b.SK as string) ? 1 : -1));
    return { events: items.slice(0, limit).map(toEvent) };
  }

  /** Roster for the fleet dashboard: identity id, capabilities, recorded
   *  status with freshness, per-class event counts. Never addresses or keys. */
  async fleetRoster(now: number = Date.now()): Promise<FleetAgent[]> {
    const items = await this.scanAll(
      "SK = :agent OR SK = :status OR begins_with(SK, :act)",
      { ":agent": "AGENT", ":status": "STATUS", ":act": "ACT#" },
    );
    const roster = new Map<string, FleetAgent>();
    const ensure = (agentId: string): FleetAgent => {
      let row = roster.get(agentId);
      if (!row) {
        row = { agentId, capabilities: [], counts: { attested: 0, claimed: 0 } };
        roster.set(agentId, row);
      }
      return row;
    };
    for (const item of items) {
      const sk = item.SK as string;
      if (sk === "AGENT") {
        const row = ensure(item.agentId as string);
        row.capabilities = (item.capabilities as string[]) ?? [];
      } else if (sk === "STATUS") {
        const row = ensure((item.PK as string).slice("AGENT#".length));
        row.status = statusView(item, now);
      } else {
        const row = ensure((item.PK as string).slice("AGENT#".length));
        if (item.class === "attested") row.counts.attested += 1;
        else if (item.class === "claimed") row.counts.claimed += 1;
      }
    }
    return [...roster.values()].sort((a, b) => a.agentId.localeCompare(b.agentId));
  }

  private async scanAll(
    filter: string, values: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let lastKey: Record<string, unknown> | undefined;
    do {
      const res = await this.ddb.send(new ScanCommand({
        TableName: this.table,
        FilterExpression: filter,
        ExpressionAttributeValues: values,
        ExclusiveStartKey: lastKey,
      }));
      items.push(...((res.Items ?? []) as Record<string, unknown>[]));
      lastKey = res.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (lastKey);
    return items;
  }
}
