import { timingSafeEqual } from "node:crypto";

import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { setProvider } from "@flue/runtime";
import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";

import { QueueClerk } from "./agents/queue-clerk.ts";
import { AccessVerifier, accessConfigFromEnvironment } from "./auth/access.ts";
import { mountMcpHttp } from "./mcp/http.ts";
import type { ArtifactVerifierOptions } from "./queue/artifact-verification.ts";
import { queueStoreOptionsFromEnvironment } from "./queue/eligibility.ts";
import { QueueStore, queueDatabasePath } from "./queue/store.ts";
import { createSurfaceApp, type SurfaceStores } from "./surface/app.ts";
import type { StreamOptions } from "./surface/stream.ts";

const lemonadeBaseUrl = process.env.LEMONADE_BASE_URL ?? "http://localhost:13305/v1";
const lemonadeModel = process.env.LEMONADE_MODEL ?? "Qwen3.8-27B-GGUF-UD-Q4_K_XL";

const { refreshModels: _refreshModels, ...lemonadeProvider } = createProvider({
  id: "lemonade",
  auth: {
    apiKey: {
      name: "Lemonade",
      resolve: async () => ({
        // Pi requires a non-empty API key even when the local endpoint does
        // not authenticate. Lemonade ignores this placeholder.
        auth: { apiKey: process.env.LEMONADE_API_KEY ?? "lemonade-local" },
      }),
    },
  },
  models: [
    {
      id: lemonadeModel,
      name: lemonadeModel,
      api: "openai-completions",
      provider: "lemonade",
      baseUrl: lemonadeBaseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 512,
    },
  ],
  api: openAICompletionsApi(),
});
// Flue 2.0.3 owns a pi-ai 0.83 Models registry. This provider is static, so
// omit pi-ai 0.84's incompatible optional refresh hook; the registered model
// and stream request shapes are otherwise the same across this boundary.
setProvider(lemonadeProvider as unknown as Parameters<typeof setProvider>[0]);

export interface AppOptions {
  appToken?: string;
  /**
   * Stores for the operator surface. Defaults to opening `SNOWCAT_QUEUE_DB`
   * lazily on the first authenticated surface request and reading
   * `SNOWCAT_CONTROL_DB` for enrollment states; tests pass their own.
   */
  surfaceStores?: () => SurfaceStores;
  /** Event-stream cadence for the surface; tests shorten it. */
  surfaceStream?: StreamOptions;
  /** Cloudflare Access at the edge for the surface (ADR-0063); local mode when absent. */
  access?: AccessVerifier;
  /**
   * The Streamable HTTP MCP endpoint at `/mcp` (ADR-0063). Off unless given
   * a queue store (the app's `surfaceStores` queue in production, a test's
   * store otherwise); minted bearer tokens are verified against it.
   */
  mcp?: { queue: () => QueueStore; queuePath: string; verifier?: ArtifactVerifierOptions };
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.get("/health", (context) => context.json({ status: "ok" }));
  app.use("/agents/*", async (context, next) => {
    const token = options.appToken;
    if (!token) {
      return context.json({ error: "SNOWCAT_APP_TOKEN is not configured" }, 503);
    }

    const authorization = context.req.header("Authorization") ?? "";
    if (!safeEqual(authorization, `Bearer ${token}`)) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: "unauthorized" }, 401);
    }

    await next();
  });
  app.route("/agents/queue-clerk", createAgentRouter(QueueClerk));
  // Workers over HTTP: `/mcp`, bearer = Snowcat-minted token, identity from
  // the token. Stdio (`npm run mcp`) stays the local mode.
  if (options.mcp) {
    mountMcpHttp(app, { queue: options.mcp.queue, queuePath: options.mcp.queuePath, verifier: options.mcp.verifier, storeOptions: queueStoreOptionsFromEnvironment() });
  }
  // The operator surface: `/login`, `/logout`, and the inbox at `/`, all
  // behind the cookie session; `/health` and `/agents/*` above are untouched.
  app.route("/", createSurfaceApp({ appToken: options.appToken, access: options.access, stores: options.surfaceStores ?? defaultSurfaceStores(), stream: options.surfaceStream }));

  return app;
}

/** Opens the host's queue store once, on first use, from the same environment the CLI reads. */
function defaultSurfaceStores(): () => SurfaceStores {
  let stores: SurfaceStores | undefined;
  return () => {
    stores ??= {
      queue: new QueueStore(queueDatabasePath()),
      controlPlanePath: process.env.SNOWCAT_CONTROL_DB && process.env.SNOWCAT_CONTROL_DB !== ":memory:" ? process.env.SNOWCAT_CONTROL_DB : undefined,
    };
    return stores;
  };
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

const hostStores = defaultSurfaceStores();
const hostAccess = accessConfigFromEnvironment();
const app = createApp({
  appToken: process.env.SNOWCAT_APP_TOKEN,
  access: hostAccess ? new AccessVerifier(hostAccess) : undefined,
  surfaceStores: hostStores,
  mcp: { queue: () => hostStores().queue, queuePath: queueDatabasePath() },
});

export default app;
