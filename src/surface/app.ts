import { Hono, type Context, type MiddlewareHandler } from "hono";

import type { QueueStore } from "../queue/store.ts";
import { readInbox } from "./inbox.ts";
import { readItem } from "./item.ts";
import { inboxPage, loginPage, notFoundPage, unavailablePage, type PageContext } from "./pages.ts";
import { itemPage } from "./pages-item.ts";
import { boardPage, repositoriesPage } from "./pages-repositories.ts";
import { readBoard, readEnrollments, readRepositoryIndex, sidebarFromEnrollments, type RepositoryEnrollment } from "./repositories.ts";
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

  /**
   * Opens the stores and reads the per-request page chrome (host box,
   * sidebar, footer); a failure renders 503 with the message. `render`
   * receives the same enrollment read so a page never opens the control
   * plane twice.
   */
  const page = (render: (stores: SurfaceStores, enrollments: Map<string, RepositoryEnrollment> | undefined, chrome: PageContext) => Response) => {
    return (context: Context) => {
      let stores: SurfaceStores;
      try {
        stores = options.stores();
      } catch (error) {
        return context.html(unavailablePage(`The queue database could not be opened: ${message(error)}`), 503);
      }
      try {
        const enrollments = readEnrollments(stores.controlPlanePath);
        const metadata = stores.queue.metadata();
        const chrome: PageContext = {
          queuePath: metadata.databasePath,
          controlPlanePath: stores.controlPlanePath,
          schemaVersion: metadata.schemaVersion,
          lastEventSequence: metadata.lastEventSequence,
          repositories: sidebarFromEnrollments(stores.queue, enrollments),
        };
        return render(stores, enrollments, chrome);
      } catch (error) {
        return context.html(unavailablePage(`The page could not be read: ${message(error)}`), 503);
      }
    };
  };

  app.get(
    "/",
    requireConfigured,
    requireSession,
    page((stores, enrollments, chrome) => new Response(inboxPage(chrome, readInbox(stores.queue, enrollments)), htmlHeaders())),
  );

  app.get(
    "/repositories",
    requireConfigured,
    requireSession,
    page((stores, enrollments, chrome) => new Response(repositoriesPage(chrome, readRepositoryIndex(stores.queue, enrollments)), htmlHeaders())),
  );

  app.get("/repositories/:owner/:name", requireConfigured, requireSession, (context) =>
    page((stores, enrollments, chrome) => {
      const slug = `${context.req.param("owner")}/${context.req.param("name")}`;
      let board;
      try {
        board = readBoard(stores.queue, slug, enrollments);
      } catch (error) {
        // An invalid slug is a 404, not a 503.
        return new Response(notFoundPage(chrome, `No repository ${slug}: ${message(error)}`), htmlHeaders(404));
      }
      if (!board) return new Response(notFoundPage(chrome, `${slug} is neither opted in to the queue nor declared in the control plane.`), htmlHeaders(404));
      return new Response(boardPage(chrome, board), htmlHeaders());
    })(context),
  );

  app.get("/items/:id", requireConfigured, requireSession, (context) =>
    page((stores, enrollments, chrome) => {
      const id = context.req.param("id");
      const item = readItem(stores.queue, id, enrollments);
      if (!item) return new Response(notFoundPage(chrome, `No work item ${id}.`), htmlHeaders(404));
      return new Response(itemPage(chrome, item), htmlHeaders());
    })(context),
  );

  return app;
}

function htmlHeaders(status = 200): ResponseInit {
  return { status, headers: { "Content-Type": "text/html; charset=UTF-8" } };
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
