import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { childEnvironment } from "./helpers/child-environment.ts";

test("serve adopts legacy environment through the canonical helper before configuration and app import", async () => {
  const source = await readFile("scripts/serve.mjs", "utf8");
  const adoption = source.indexOf("\nadoptLegacyEnvironment();");
  assert.ok(adoption >= 0, "serve must call the canonical compatibility helper");
  assert.ok(adoption < source.indexOf("const entry ="), "legacy adoption must precede app entry resolution");
  assert.ok(adoption < source.indexOf("process.env.HOST"), "legacy adoption must precede serve configuration reads");
  assert.doesNotMatch(source, /FLUENT_/, "serve must not carry a second legacy-adoption implementation");

  const fixture = await mkdtemp(join(process.cwd(), "test/.serve-entry-"));
  try {
    await Promise.all([
      mkdir(join(fixture, "scripts")),
      mkdir(join(fixture, "src")),
      mkdir(join(fixture, "dist")),
    ]);
    await Promise.all([
      copyFile("scripts/serve.mjs", join(fixture, "scripts/serve.mjs")),
      copyFile("src/env-compat.ts", join(fixture, "src/env-compat.ts")),
      writeFile(
        join(fixture, "dist/app.mjs"),
        `const queueAtImport = process.env.SNOWCAT_QUEUE_DB;
export async function startFlueNodeServer(options) {
  console.log("serve-probe " + JSON.stringify({ queueAtImport, options }));
  return { stop: async () => {} };
}
`,
      ),
    ]);

    const run = (overrides: Record<string, string>) => spawnSync(
      process.execPath,
      [join(fixture, "scripts/serve.mjs")],
      {
        cwd: fixture,
        encoding: "utf8",
        env: childEnvironment({ HOST: "127.0.0.2", PORT: "4321", ...overrides }),
      },
    );

    const adopted = run({ FLUENT_QUEUE_DB: "/legacy/queue.db" });
    assert.equal(adopted.status, 0, adopted.stderr);
    assert.match(adopted.stderr, /adopted legacy FLUENT_QUEUE_DB; rename to SNOWCAT_\*/);
    assert.deepEqual(probe(adopted.stdout), {
      queueAtImport: "/legacy/queue.db",
      options: { hostname: "127.0.0.2", port: 4321, quiet: true },
    });

    const modernWins = run({
      FLUENT_QUEUE_DB: "/legacy/queue.db",
      SNOWCAT_QUEUE_DB: "/modern/queue.db",
    });
    assert.equal(modernWins.status, 0, modernWins.stderr);
    assert.doesNotMatch(modernWins.stderr, /FLUENT_QUEUE_DB/);
    assert.equal(probe(modernWins.stdout).queueAtImport, "/modern/queue.db");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

function probe(stdout: string): { queueAtImport?: string; options: { hostname: string; port: number; quiet: boolean } } {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("serve-probe "));
  assert.ok(line, `serve probe output is missing:\n${stdout}`);
  return JSON.parse(line.slice("serve-probe ".length));
}
