import { cpSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { flue } from "@flue/vite";
import { defineConfig, type Plugin } from "vite";

/**
 * The Core validator reads its bundled JSON schemas from
 * `./schemas/v1/*.json` next to `import.meta.url` and digests their exact
 * bytes. Vite inlines the module but not those files, so the built server
 * must ship them beside the bundle; `scripts/check-dist.mjs` verifies the
 * copy after every build.
 */
function copyBundledSchemas(): Plugin {
  return {
    name: "fluent-copy-bundled-schemas",
    closeBundle() {
      mkdirSync(resolve("dist/schemas"), { recursive: true });
      cpSync(resolve("src/core/schemas"), resolve("dist/schemas"), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [flue({ providers: [] }), copyBundledSchemas()],
});
