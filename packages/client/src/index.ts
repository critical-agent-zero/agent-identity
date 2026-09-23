export * from "./client.js";
export * from "./profile.js";
export * from "./claims.js";
export * from "./config.js";
export * from "./provision.js";
export * from "./setup.js";
export * from "./checklist.js";
export * from "./wizard.js";
// github-onboard is intentionally NOT re-exported: it is operator-only (bot
// account PAT + email management) and must not surface from the library the
// agent-facing MCP server depends on. The CLI imports the module directly.
// admin is likewise NOT re-exported: it resolves the operator admin key
// (capability granting), which must never surface to agents or the MCP
// server. The CLI imports the module directly.
