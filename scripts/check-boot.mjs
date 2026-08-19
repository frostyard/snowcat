#!/usr/bin/env node
// Proves that the built operator surface starts: imports dist/app.mjs, calls
// its exported `startFlueNodeServer` on 127.0.0.1 with an ephemeral port, and
// stops it. `npm run build` runs this after vite build and check-dist so a
// bundle that fails at import or listen time fails `npm run check` and CI,
// not the first `npm run serve` after an upgrade.
//
// The boot runs in a child process whose working directory is a fresh temp
// directory: src/db.ts opens Flue's store at ./data/flue.db relative to cwd,
// so booting in the checkout (where deploy/upgrade.sh runs `npm run check`)
// would open the live one. SNOWCAT_*/FLUENT_*/FLUE_* are scrubbed from the
// child's environment and SNOWCAT_QUEUE_DB points into the same temp
// directory, so the step needs nothing from /etc/snowcat/env, touches no
// live database, and binds only loopback.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const IMPORT_TIMEOUT_MS = 15_000;
const LISTEN_TIMEOUT_MS = 15_000;
const CHILD_TIMEOUT_MS = 60_000;

if (process.argv[2] === "child") {
  await child(process.argv[3]);
} else {
  parent();
}

function parent() {
  const app = resolve("dist/app.mjs");
  if (!existsSync(app)) {
    console.error(`check-boot: ${app} is missing; vite build did not produce the app entry`);
    process.exit(1);
  }
  const workdir = mkdtempSync(join(tmpdir(), "snowcat-check-boot-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(SNOWCAT|FLUENT|FLUE)_/.test(key)),
  );
  env.SNOWCAT_QUEUE_DB = join(workdir, "queue.db");
  let code = 1;
  try {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "child", pathToFileURL(app).href],
      { cwd: workdir, env, stdio: "inherit", timeout: CHILD_TIMEOUT_MS },
    );
    if (result.error) {
      console.error(`check-boot: boot process failed: ${result.error.message}`);
    } else if (result.signal) {
      console.error(`check-boot: boot process killed by ${result.signal} (did not finish within ${CHILD_TIMEOUT_MS} ms)`);
    } else {
      code = result.status ?? 1;
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
  process.exit(code);
}

async function child(appUrl) {
  const started = Date.now();
  try {
    const bundle = await withTimeout(import(appUrl), IMPORT_TIMEOUT_MS, `import of ${appUrl}`);
    if (typeof bundle.startFlueNodeServer !== "function") {
      throw new Error(`${appUrl} does not export a startFlueNodeServer function (got ${typeof bundle.startFlueNodeServer})`);
    }
    const server = await withTimeout(
      bundle.startFlueNodeServer({ hostname: "127.0.0.1", port: 0, quiet: true, signal: AbortSignal.timeout(LISTEN_TIMEOUT_MS) }),
      LISTEN_TIMEOUT_MS,
      "startFlueNodeServer",
    );
    await withTimeout(server.stop(), LISTEN_TIMEOUT_MS, "server.stop");
    console.log(`check-boot: dist/app.mjs imported, startFlueNodeServer listened on 127.0.0.1 (ephemeral port) and stopped in ${Date.now() - started} ms`);
    process.exit(0);
  } catch (error) {
    console.error(`check-boot: the built operator surface failed to start: ${error?.stack ?? error}`);
    process.exit(1);
  }
}

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not complete within ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
