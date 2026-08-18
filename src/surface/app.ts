import { Hono, type MiddlewareHandler } from "hono";

import type { QueueStore } from "../queue/store.ts";
import { readInbox } from "./inbox.ts";
import { inboxPage, loginPage, unavailablePage } from "./pages.ts";
import { clearedSessionCookie, hasValidSession, sessionCookie, tokenMatches } from "./session.ts";

export interface SurfaceStores {
  queue: QueueStore;
  /** `FLUENT_CONTROL_DB` when configured; the sidebar then shows enrollment states. */
  controlPlanePath?: string;
}

export interface SurfaceOptions {
  /** `FLUENT_APP_TOKEN`; when absent every surface route answers 503, like `/agents/*`. */
  appToken?: string;
  /**
   * Opens (or returns the already-open) stores. Called per request after the
   * session check so an unauthenticated visitor never triggers a database
   * open; a throw renders as 503 with the message.
   */
  stores: () => SurfaceStores;
}

/**
 * The read-first operator surface (ADR-0060): a cookie session over
 * `FLUENT_APP_TOKEN`, then server-rendered pages over the same `QueueStore`
 * methods the CLI uses. No route mutates the queue in this slice.
 */
export function createSurfaceApp(options: SurfaceOptions): Hono {
  const app = new Hono();

  // Fail closed for the whole surface, login included, when no token is
  // configured. Applied per route rather than as a catch-all so mounting at
  // `/` never shadows `/health` or an unmatched `/agents/*` path.
  const requireConfigured: MiddlewareHandler = async (context, next) => {
    if (!options.appToken) {
      return context.html(unavailablePage("FLUENT_APP_TOKEN is not configured on this host, so the operator surface is disabled."), 503);
    }
    await next();
  };
  const requireSession: MiddlewareHandler = async (context, next) => {
    if (!hasValidSession(context.req.header("Cookie"), options.appToken!)) return context.redirect("/login", 303);
    await next();
  };

  app.get("/login", requireConfigured, (context) => {
    if (hasValidSession(context.req.header("Cookie"), options.appToken!)) return context.redirect("/", 303);
    return context.html(loginPage({}));
  });

  app.post("/login", requireConfigured, async (context) => {
    const body = await context.req.parseBody();
    const submitted = typeof body.token === "string" ? body.token : "";
    if (!tokenMatches(submitted, options.appToken!)) {
      return context.html(loginPage({ error: "That token does not match FLUENT_APP_TOKEN." }), 401);
    }
    context.header("Set-Cookie", sessionCookie(options.appToken!, isSecure(context.req.url)));
    return context.redirect("/", 303);
  });

  app.post("/logout", requireConfigured, (context) => {
    context.header("Set-Cookie", clearedSessionCookie());
    return context.redirect("/login", 303);
  });

  app.get("/", requireConfigured, requireSession, (context) => {
    let stores: SurfaceStores;
    try {
      stores = options.stores();
    } catch (error) {
      return context.html(unavailablePage(`The queue database could not be opened: ${message(error)}`), 503);
    }
    try {
      return context.html(inboxPage(readInbox(stores.queue, stores.controlPlanePath)));
    } catch (error) {
      return context.html(unavailablePage(`The inbox could not be read: ${message(error)}`), 503);
    }
  });

  return app;
}

function isSecure(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
