#!/usr/bin/env node
// Deploy-log leak invariants (#77), enforced as a committed CI lint rather than
// a scratchpad script. GitHub Actions logs are world-readable on this public
// repo, so:
//   1. Sensitive config (MAIL_DOMAIN, BUDGET_EMAIL) must come from `secrets.*`,
//      never `vars.*` or a literal. The runner prints each step's env block in
//      the log header BEFORE the script runs; secrets are registered with the
//      masker at job setup, but repo variables are never masked.
//   2. Any step that runs `cdk deploy` must strip the stack Outputs
//      (ApiUrl / MxRecord / TableName) from the piped log.
// The check is a pure function over each workflow's text so it is unit-tested;
// run directly, it lints every .github/workflows/*.yml and exits non-zero on a
// violation.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_ONLY = ["MAIL_DOMAIN", "BUDGET_EMAIL"];

/** Return a list of invariant violations for one workflow file's text.
 *  Empty array = clean. `filename` only labels the messages. */
export function workflowViolations(content, filename) {
  const v = [];

  for (const name of SECRET_ONLY) {
    // `vars.<NAME>` is never auto-masked in logs — forbidden outright.
    if (new RegExp(String.raw`vars\.${name}\b`).test(content)) {
      v.push(`${filename}: reads ${name} from vars.${name}; use secrets.${name} (repo variables are never masked in logs)`);
    }
    // Every `NAME: <value>` env assignment must reference secrets.<NAME>.
    const assign = new RegExp(String.raw`^[ \t]*${name}:[ \t]*(\S.*)$`, "gm");
    for (let m; (m = assign.exec(content)) !== null; ) {
      const value = m[1].trim();
      const ok = new RegExp(String.raw`^\$\{\{\s*secrets\.${name}\s*\}\}$`).test(value);
      if (!ok) {
        v.push(`${filename}: env ${name} is \`${value}\`; it must be \${{ secrets.${name} }}`);
      }
    }
  }

  // A `cdk deploy` whose output reaches the log must strip the stack Outputs.
  // `cdk synth` is exempt (it prints no stack outputs). The strip is recognised
  // by a sed/awk that deletes the stack's `AgentIdentity.<Key> = <value>` lines
  // (the robust, format-independent form) or the `Outputs:` block header.
  if (/\bcdk deploy\b/.test(content)) {
    // A strip is recognised by a sed/awk that deletes the stack's escaped
    // `AgentIdentity\.<Key>` output lines, or the `/^Outputs:$/` block header.
    const strips = /AgentIdentity\\\./.test(content) || /\/\^Outputs:\$\//.test(content);
    if (!strips) {
      v.push(`${filename}: runs \`cdk deploy\` but does not strip the stack Outputs (ApiUrl/MxRecord/TableName) from the log — pipe it through a sed that deletes 'AgentIdentity.<Key> = ' lines`);
    }
  }

  return v;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const dir = join(here, "..", ".github", "workflows");
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"));
  } catch (err) {
    console.error(`check-workflows: cannot read ${dir}: ${err.message}`);
    process.exit(2);
  }
  const violations = [];
  for (const f of files) {
    violations.push(...workflowViolations(readFileSync(join(dir, f), "utf8"), f));
  }
  if (violations.length > 0) {
    console.error("Workflow leak-invariant violations:");
    for (const line of violations) console.error(`  - ${line}`);
    process.exit(1);
  }
  console.log(`check-workflows: ${files.length} workflow(s) clean`);
}

// Run the CLI only when executed directly, so the pure function stays importable.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
