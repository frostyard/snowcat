#!/usr/bin/env node
// Starts the built Snowcat app (`npm run build` → dist/app.mjs) bound to
// HOST (default 127.0.0.1) and PORT (default 3000). Flue's own
// `dist/server.mjs` entry accepts PORT only and lets Node pick the
// interface, so this wrapper is the documented way to run the operator
// surface: loopback unless HOST says otherwise. Exposing it beyond the host
// is a deployment decision, not a default.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { adoptLegacyEnvironment } from "../src/env-compat.ts";

adoptLegacyEnvironment();
const entry = new URL("../dist/app.mjs", import.meta.url);
if (!existsSync(fileURLToPath(entry))) {
  console.error("dist/app.mjs is missing; run `npm run build` first.");
  process.exit(1);
}
const { startFlueNodeServer } = await import(entry.href);
const hostname = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "3000", 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT must be an integer between 0 and 65535, got ${process.env.PORT}`);
  process.exit(1);
}
const server = await startFlueNodeServer({ hostname, port, quiet: true });
console.log(`[snowcat] operator surface listening on http://${hostname}:${port}${hostname === "127.0.0.1" ? " (loopback only; set HOST to bind elsewhere)" : ""}`);
async function stop(code) {
  setTimeout(() => process.exit(code), 30_000).unref();
  await server.stop();
  process.exit(code);
}
process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
