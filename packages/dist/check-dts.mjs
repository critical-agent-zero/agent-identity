// Guard: the published d.ts must not reference private @agent-identity/* workspace
// packages — consumers can never install them, so any such import breaks all types (#38).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dtsPath = fileURLToPath(new URL("./dist/index.d.ts", import.meta.url));
const dts = readFileSync(dtsPath, "utf8");

const hits = dts
  .split("\n")
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => line.includes("@agent-identity/"));

if (hits.length > 0) {
  console.error("check-dts: dist/index.d.ts references private workspace packages:");
  for (const { line, n } of hits) console.error(`  ${n}: ${line.trim()}`);
  console.error("check-dts: enable dts resolution in tsup.config.ts so types are inlined.");
  process.exit(1);
}

if (!/\bdeclare\b|\binterface\b|\btype\b/.test(dts)) {
  console.error("check-dts: dist/index.d.ts contains no real declarations.");
  process.exit(1);
}

console.log("check-dts: dist/index.d.ts is self-contained.");
