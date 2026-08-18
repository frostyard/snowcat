// Verifies that `npm run build` shipped every bundled Core schema beside the
// server bundle, byte-identical to src/core/schemas, so the built server can
// validate governance and Core catalogs exactly as the tsx-run CLI does.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const source = "src/core/schemas";
const built = "dist/schemas";
let checked = 0;
function walk(relative) {
  for (const name of readdirSync(join(source, relative))) {
    const rel = join(relative, name);
    if (statSync(join(source, rel)).isDirectory()) {
      walk(rel);
      continue;
    }
    let builtBytes;
    try {
      builtBytes = readFileSync(join(built, rel));
    } catch {
      console.error(`check-dist: ${join(built, rel)} is missing; the build did not copy the bundled schemas`);
      process.exit(1);
    }
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    if (digest(readFileSync(join(source, rel))) !== digest(builtBytes)) {
      console.error(`check-dist: ${join(built, rel)} differs from ${join(source, rel)}`);
      process.exit(1);
    }
    checked += 1;
  }
}
walk("");
if (checked === 0) {
  console.error("check-dist: no schema files found under src/core/schemas");
  process.exit(1);
}
console.log(`check-dist: ${checked} bundled schema file(s) shipped byte-identical under dist/schemas`);
