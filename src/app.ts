import { timingSafeEqual } from "node:crypto";

import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { setProvider } from "@flue/runtime";
import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";

import { QueueClerk } from "./agents/queue-clerk.ts";
import { QueueStore, queueDatabasePath } from "./queue/store.ts";
import { createSurfaceApp, type SurfaceStores } from "./surface/app.ts";
import type { StreamOptions } from "./surface/stream.ts";

const lemonadeBaseUrl = process.env.LEMONADE_BASE_URL ?? "http://10.0.1.200:13305/v1";
const lemonadeModel = process.env.LEMONADE_MODEL ?? "Qwen3.8-27B-GGUF-UD-Q4_K_XL";

setProvider(
  createProvider({
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
  }),
);

export interface AppOptions {
  appToken?: string;
  /**
   * Stores for the operator surface. Defaults to opening `FLUENT_QUEUE_DB`
   * lazily on the first authenticated surface request and reading
   * `FLUENT_CONTROL_DB` for enrollment states; tests pass their own.
   */
  surfaceStores?: () => SurfaceStores;
  /** Event-stream cadence for the surface; tests shorten it. */
  surfaceStream?: StreamOptions;
}

export function createApp(options: AppOptions): Hono {
  const app = new Hono();

  app.get("/health", (context) => context.json({ status: "ok" }));
  app.use("/agents/*", async (context, next) => {
    const token = options.appToken;
    if (!token) {
      return context.json({ error: "FLUENT_APP_TOKEN is not configured" }, 503);
    }

    const authorization = context.req.header("Authorization") ?? "";
    if (!safeEqual(authorization, `Bearer ${token}`)) {
      context.header("WWW-Authenticate", "Bearer");
      return context.json({ error: "unauthorized" }, 401);
    }

    await next();
  });
  app.route("/agents/queue-clerk", createAgentRouter(QueueClerk));
  // The operator surface: `/login`, `/logout`, and the inbox at `/`, all
  // behind the cookie session; `/health` and `/agents/*` above are untouched.
  app.route("/", createSurfaceApp({ appToken: options.appToken, stores: options.surfaceStores ?? defaultSurfaceStores(), stream: options.surfaceStream }));

  return app;
}

/** Opens the host's queue store once, on first use, from the same environment the CLI reads. */
function defaultSurfaceStores(): () => SurfaceStores {
  let stores: SurfaceStores | undefined;
  return () => {
    stores ??= {
      queue: new QueueStore(queueDatabasePath()),
      controlPlanePath: process.env.FLUENT_CONTROL_DB && process.env.FLUENT_CONTROL_DB !== ":memory:" ? process.env.FLUENT_CONTROL_DB : undefined,
    };
    return stores;
  };
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

const app = createApp({ appToken: process.env.FLUENT_APP_TOKEN });

export default app;
