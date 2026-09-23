// Generates demo.cast (asciicast v2) for the agent-identity setup demo.
// Content mirrors real wizard transcripts captured on 2026-09-22/23, with the
// mail domain, minted agent id, and API id masked at authoring time.
import { writeFileSync } from "node:fs";

const events = [];
let t = 0.6;
const out = (s, dt = 0) => { t += dt; events.push([Number(t.toFixed(3)), "o", s]); };
const PROMPT = "[1;36m❯[0m ";
const type = (s, cps = 0.034) => { for (const ch of s) out(ch, cps); };
const enterKey = (pause = 0.15) => out("\r\n", pause);
const cmd = (s, pre = 0.7) => { out(PROMPT, pre); type(s); enterKey(); };
const comment = (s, pre = 0.8) => { out(PROMPT, pre); out("[2m", 0); type(s, 0.022); out("[0m", 0); enterKey(); };

comment("# Give your AI agents persistent identities — each with its own email inbox");
out("", 1.2);

cmd("npm install @critical-labs/agent-identity");
out("\r\nadded 96 packages in 3s\r\n", 2.2);

cmd("npx agent-identity setup", 0.9);
out("agent-identity setup\r\n", 1.0);
out("Backend: [1] connect to an existing deployment (requires an API URL + fleet key from an operator)  [2] deploy a new one [1]: ", 0.5);
enterKey(1.4);
out("API URL [https://****.execute-api.us-east-1.amazonaws.com]: ", 0.3);
enterKey(1.3);
out("Fleet key [keep existing]: ", 0.3);
enterKey(1.2);
out("How many identities should I provision now? [0]: ", 0.3);
type("1", 0.5); enterKey(0.3);
out("[32mminted ****** <******@agents.*****.org>[0m\r\n", 1.6);
out("1/1 identities provisioned\r\n", 0.15);
out("Require a GitHub-capable identity for this repo? [y/N]: ", 0.5);
enterKey(1.1);
out("wrote /Users/dev/acme-app/.mcp.json\r\n", 0.4);
out("installed skill at /Users/dev/acme-app/.claude/skills/agent-identity\r\n", 0.25);
out("\r\nSetup complete. Restart your Claude session and call ensure_identity.\r\n", 0.35);

cmd("cat .mcp.json", 1.3);
out(
  [
    "{",
    '  "mcpServers": {',
    '    "agent-identity": {',
    '      "command": "npx",',
    '      "args": ["-y", "-p", "@critical-labs/agent-identity", "agent-identity-mcp"],',
    '      "env": { "AGENT_IDENTITY_API_URL": "https://****.execute-api.us-east-1.amazonaws.com" }',
    "    }",
    "  }",
    "}",
  ].join("\r\n") + "\r\n",
  0.5,
);

comment("# identity + mailbox minted · MCP server wired · skill installed · zero secrets in-repo", 1.4);

// End hold before the loop restarts: ~5.5s at an idle prompt with a blinking
// cursor (DECTCEM hide/show toggles) so readers have time to take in the
// full transcript and the pause reads as time passing, not a frozen frame.
out(PROMPT, 0.6);
for (let i = 0; i < 5; i++) {
  out("[?25l", 0.55);
  out("[?25h", 0.55);
}
out("", 0.4);

const header = { version: 2, width: 104, height: 28, title: "agent-identity setup" };
writeFileSync(
  new URL("./demo.cast", import.meta.url),
  JSON.stringify(header) + "\n" + events.map((e) => JSON.stringify(e)).join("\n") + "\n",
);
console.log("demo.cast written:", events.length, "events, duration", t.toFixed(1) + "s");
