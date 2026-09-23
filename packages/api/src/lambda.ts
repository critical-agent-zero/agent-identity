import { parseRepoAllowlist } from "@agent-identity/shared";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { ActivityRepo } from "./db/activity.js";
import { AgentsRepo } from "./db/agents.js";
import { EmailsRepo } from "./db/emails.js";
import { NoncesRepo } from "./db/nonces.js";

const table = process.env.TABLE_NAME!;
const domain = process.env.MAIL_DOMAIN!;
const bucket = process.env.BUCKET_NAME!;
const retentionDays = Number(process.env.RETENTION_DAYS ?? "90");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const app = createApp({
  agents: new AgentsRepo(ddb, table, domain),
  emails: new EmailsRepo(ddb, table, retentionDays),
  activity: new ActivityRepo(ddb, table, retentionDays),
  nonces: new NoncesRepo(ddb, table),
  readBody: async (key) => {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await res.Body!.transformToString());
  },
  fleetKeyRequired: process.env.FLEET_KEY_REQUIRED !== "false",
  // Unset or empty PUBLIC_REPOS parses to the empty allowlist: the public
  // fleet tier then shows no forge events at all — fail closed.
  publicRepos: parseRepoAllowlist(process.env.PUBLIC_REPOS ?? ""),
  // Operator deployment policy: capability slugs /register may grant at
  // identity birth. Unset or empty = feature off (fail closed).
  autoCapabilities: (process.env.AUTO_CAPABILITIES ?? "")
    .split(",").map((s) => s.trim()).filter((s) => s.length > 0),
});

export const handler = handle(app);
