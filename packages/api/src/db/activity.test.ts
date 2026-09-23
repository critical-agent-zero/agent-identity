import type { ActivityEvent } from "@agent-identity/shared";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { InvalidCursorError } from "./emails.js";
import { ActivityRepo, STATUS_FRESH_MS } from "./activity.js";

const ddb = mockClient(DynamoDBDocumentClient);
const repo = new ActivityRepo(ddb as never, "tbl", 90);

beforeEach(() => ddb.reset());

const claimed: ActivityEvent = {
  agentId: "482913", ts: "2026-09-23T10:00:00.000Z", class: "claimed",
  type: "status", summary: "status: working", detail: { state: "working" },
};

const attested: ActivityEvent = {
  agentId: "482913", ts: "2026-09-23T10:00:00.000Z", class: "attested",
  type: "forge_commit", summary: "committed to o/r@main",
  detail: { repo: "o/r", sha: "abc", branch: "main" }, ref: "https://forge/c1",
};

describe("ActivityRepo.putEvent", () => {
  it("writes AGENT partition with ACT#<iso-ts>#<ulid> sort key", async () => {
    ddb.on(PutCommand).resolves({});
    await repo.putEvent(attested);
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item.PK).toBe("AGENT#482913");
    expect(item.SK).toMatch(/^ACT#2026-09-23T10:00:00\.000Z#[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(item.type).toBe("forge_commit");
    expect(item.class).toBe("attested");
  });

  it("gives claimed events a retention TTL", async () => {
    ddb.on(PutCommand).resolves({});
    await repo.putEvent(claimed);
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    const ttlDelta = (item.expiresAt as number) - Date.parse(claimed.ts) / 1000;
    expect(ttlDelta).toBe(90 * 24 * 3600);
  });

  it("never sets a TTL on attested events", async () => {
    ddb.on(PutCommand).resolves({});
    await repo.putEvent(attested);
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item).not.toHaveProperty("expiresAt");
  });
});

describe("ActivityRepo.listEvents", () => {
  it("queries the agent's ACT range newest-first and maps events", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [{
        PK: "AGENT#482913", SK: "ACT#t#01A", agentId: "482913", ts: "t",
        class: "attested", type: "forge_pr", summary: "opened PR", ref: "u",
      }],
    });
    const { events } = await repo.listEvents("482913", {});
    expect(events).toEqual([{
      agentId: "482913", ts: "t", class: "attested", type: "forge_pr",
      summary: "opened PR", ref: "u",
    }]);
    const q = ddb.commandCalls(QueryCommand)[0].args[0].input;
    expect(q.ScanIndexForward).toBe(false);
    expect(q.ExpressionAttributeValues).toMatchObject({
      ":pk": "AGENT#482913", ":pfx": "ACT#",
    });
  });

  it("never leaks non-event attributes (defense-in-depth allowlist)", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [{
        PK: "AGENT#482913", SK: "ACT#t#01A", agentId: "482913", ts: "t",
        class: "claimed", type: "task_note", summary: "n",
        address: "482913@mail.example.com", expiresAt: 123,
      }],
    });
    const { events } = await repo.listEvents("482913", {});
    const json = JSON.stringify(events);
    expect(json).not.toContain("address");
    expect(json).not.toContain("expiresAt");
  });

  it("pages with an opaque cursor and rejects malformed cursors", async () => {
    ddb.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { PK: "AGENT#482913", SK: "ACT#x" } });
    const { cursor } = await repo.listEvents("482913", {});
    expect(cursor).toBeTruthy();
    await repo.listEvents("482913", { cursor });
    const q2 = ddb.commandCalls(QueryCommand)[1].args[0].input;
    expect(q2.ExclusiveStartKey).toEqual({ PK: "AGENT#482913", SK: "ACT#x" });

    await expect(repo.listEvents("482913", { cursor: "notacursor" }))
      .rejects.toBeInstanceOf(InvalidCursorError);
  });
});

describe("ActivityRepo status row", () => {
  it("setStatus overwrites the single STATUS row", async () => {
    ddb.on(PutCommand).resolves({});
    await repo.setStatus("482913", {
      state: "working", label: "shipping ledger", updatedAt: "2026-09-23T10:00:00.000Z",
    });
    const item = ddb.commandCalls(PutCommand)[0].args[0].input.Item!;
    expect(item).toEqual({
      PK: "AGENT#482913", SK: "STATUS",
      state: "working", label: "shipping ledger", updatedAt: "2026-09-23T10:00:00.000Z",
    });
  });

  it("getStatus computes freshness at read time", async () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    ddb.on(GetCommand).resolves({
      Item: { state: "working", label: "l", updatedAt: new Date(now - STATUS_FRESH_MS + 1000).toISOString() },
    });
    const fresh = await repo.getStatus("482913", now);
    expect(fresh).toMatchObject({ state: "working", label: "l", stale: false });

    ddb.on(GetCommand).resolves({
      Item: { state: "working", updatedAt: new Date(now - STATUS_FRESH_MS - 1000).toISOString() },
    });
    const stale = await repo.getStatus("482913", now);
    expect(stale?.stale).toBe(true);
  });

  it("getStatus returns undefined when never set", async () => {
    ddb.on(GetCommand).resolves({});
    expect(await repo.getStatus("482913")).toBeUndefined();
  });
});

describe("ActivityRepo fleet reads", () => {
  it("listFleetEvents merges partitions newest-first with a limit", async () => {
    ddb.on(ScanCommand).resolves({
      Items: [
        { PK: "AGENT#1", SK: "ACT#2026-09-23T09:00:00.000Z#01A", agentId: "1", ts: "2026-09-23T09:00:00.000Z", class: "attested", type: "forge_commit", summary: "old" },
        { PK: "AGENT#2", SK: "ACT#2026-09-23T11:00:00.000Z#01C", agentId: "2", ts: "2026-09-23T11:00:00.000Z", class: "claimed", type: "status", summary: "newest" },
        { PK: "AGENT#1", SK: "ACT#2026-09-23T10:00:00.000Z#01B", agentId: "1", ts: "2026-09-23T10:00:00.000Z", class: "attested", type: "forge_pr", summary: "mid" },
      ],
    });
    const { events } = await repo.listFleetEvents({ limit: 2 });
    expect(events.map((e) => e.summary)).toEqual(["newest", "mid"]);
    const scan = ddb.commandCalls(ScanCommand)[0].args[0].input;
    expect(scan.FilterExpression).toContain("begins_with(SK");
  });

  it("fleetRoster aggregates records, status freshness, and per-class counts without addresses", async () => {
    const now = Date.parse("2026-09-23T12:00:00.000Z");
    ddb.on(ScanCommand).resolves({
      Items: [
        { PK: "AGENT#fp1", SK: "AGENT", agentId: "111111", address: "111111@mail.example.com", publicKey: "PK1", status: "active", capabilities: ["github"] },
        { PK: "AGENT#fp2", SK: "AGENT", agentId: "222222", address: "222222@mail.example.com", publicKey: "PK2", status: "active" },
        { PK: "AGENT#111111", SK: "STATUS", state: "working", label: "l", updatedAt: new Date(now - 1000).toISOString() },
        { PK: "AGENT#111111", SK: "ACT#t1#01A", agentId: "111111", ts: "t1", class: "attested", type: "forge_commit", summary: "s" },
        { PK: "AGENT#111111", SK: "ACT#t2#01B", agentId: "111111", ts: "t2", class: "claimed", type: "status", summary: "s" },
        { PK: "AGENT#111111", SK: "ACT#t3#01C", agentId: "111111", ts: "t3", class: "attested", type: "forge_pr", summary: "s" },
      ],
    });
    const roster = await repo.fleetRoster(now);
    expect(roster).toEqual([
      {
        agentId: "111111", capabilities: ["github"],
        status: { state: "working", label: "l", updatedAt: new Date(now - 1000).toISOString(), stale: false },
        counts: { attested: 2, claimed: 1 },
      },
      { agentId: "222222", capabilities: [], counts: { attested: 0, claimed: 0 } },
    ]);
    expect(JSON.stringify(roster)).not.toContain("mail.example.com");
    expect(JSON.stringify(roster)).not.toContain("publicKey");
  });
});
