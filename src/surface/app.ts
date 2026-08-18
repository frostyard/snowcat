import { Hono, type Context, type MiddlewareHandler } from "hono";

import type { ArtifactVerifierOptions } from "../queue/artifact-verification.ts";
import type { QueueStore } from "../queue/store.ts";
import { readInbox } from "./inbox.ts";
import { readItem } from "./item.ts";
import { inboxPage, loginPage, notFoundPage, unavailablePage, type PageContext } from "./pages.ts";
import { itemPage } from "./pages-item.ts";
import { boardPage, repositoriesPage } from "./pages-repositories.ts";
import { itemPath, repositoryPath } from "./pages.ts";
import {
  MutationInputError,
  applyItemMutation,
  applyVerifyArtifacts,
  isPreconditionMismatch,
  itemMutations,
  returnPath,
  type ItemMutation,
} from "./mutations.ts";
import { readBoard, readEnrollments, readRepositoryIndex, sidebarFromEnrollments, type RepositoryEnrollment } from "./repositories.ts";
import { clearedSessionCookie, hasValidSession, sessionCookie, tokenMatches } from "./session.ts";

export interface SurfaceStores {
  queue: QueueStore;
  /** `FLUENT_CONTROL_DB` when configured; the sidebar then shows enrollment states. */
  controlPlanePath?: string;
  /** GitHub fetcher/clock for re-verification; production uses the defaults (and `FLUENT_GITHUB_TOKEN`). */
  verifier?: ArtifactVerifierOptions;
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
  // Mutations are same-origin form posts: the SameSite=Strict cookie already
  // keeps a cross-site page from carrying the session, and this refuses the
  // request outright when the browser says where it came from.
  const requireSameOrigin: MiddlewareHandler = async (context, next) => {
    const site = context.req.header("Sec-Fetch-Site");
    if (site !== undefined && site !== "same-origin" && site !== "none") return context.text("cross-site request refused", 403);
    const origin = context.req.header("Origin");
    if (origin !== undefined && origin !== "null") {
      let originHost: string;
      try {
        originHost = new URL(origin).host;
      } catch {
        return context.text("cross-site request refused", 403);
      }
      const host = context.req.header("Host") ?? new URL(context.req.url).host;
      if (originHost !== host) return context.text("cross-site request refused", 403);
    }
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
  const page = (
    render: (stores: SurfaceStores, enrollments: Map<string, RepositoryEnrollment> | undefined, chrome: PageContext) => Response | Promise<Response>,
  ) => {
    return async (context: Context) => {
      let stores: SurfaceStores;
      try {
        stores = options.stores();
      } catch (error) {
        return context.html(unavailablePage(`The queue database could not be opened: ${message(error)}`), 503);
      }
      try {
        const enrollments = readEnrollments(stores.controlPlanePath);
        const chrome = pageContext(stores, enrollments, bannerFromQuery(context));
        return await render(stores, enrollments, chrome);
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

  // Mutations: exactly the CLI's operator commands, attributed operator:web,
  // guarded by the precondition every form carries from render.
  app.post("/items/:id/:mutation", requireConfigured, requireSession, requireSameOrigin, (context) =>
    page(async (stores, enrollments, chrome) => {
      const id = context.req.param("id");
      const mutation = context.req.param("mutation");
      if (!(itemMutations as readonly string[]).includes(mutation)) {
        return new Response(notFoundPage(chrome, `No such action: ${mutation}.`), htmlHeaders(404));
      }
      const body = await formBody(context);
      const back = returnPath(body, itemPath(id));
      try {
        const outcome = applyItemMutation(stores.queue, mutation as ItemMutation, id, body);
        return redirectWithBanner(back, outcome.eventType);
      } catch (error) {
        const item = readItem(stores.queue, id, enrollments);
        if (!item) return new Response(notFoundPage(chrome, `No work item ${id}.`), htmlHeaders(404));
        if (isPreconditionMismatch(error)) {
          const banner = {
            tone: "error" as const,
            text: `This item changed since you read it: it is now ${error.status} (updated ${error.updatedAt}). Nothing was changed — decide again from the current state below.`,
          };
          return new Response(itemPage({ ...chrome, banner }, item), htmlHeaders(409));
        }
        const status = error instanceof MutationInputError ? 400 : 409;
        const banner = { tone: "error" as const, text: `${capitalize(mutation)} was not applied: ${message(error)}` };
        return new Response(itemPage({ ...chrome, banner }, item), htmlHeaders(status));
      }
    })(context),
  );

  app.post("/repositories/:owner/:name/verify-artifacts", requireConfigured, requireSession, requireSameOrigin, (context) =>
    page(async (stores, enrollments, chrome) => {
      const slug = `${context.req.param("owner")}/${context.req.param("name")}`;
      const body = await formBody(context);
      const back = returnPath(body, repositoryPath(slug));
      let board;
      try {
        board = readBoard(stores.queue, slug, enrollments);
      } catch (error) {
        return new Response(notFoundPage(chrome, `No repository ${slug}: ${message(error)}`), htmlHeaders(404));
      }
      if (!board) return new Response(notFoundPage(chrome, `${slug} is neither opted in to the queue nor declared in the control plane.`), htmlHeaders(404));
      const outcome = await applyVerifyArtifacts(stores.queue, slug, stores.verifier ?? {});
      const detail = `${outcome.checked} checked, ${outcome.updated} updated, ${outcome.rejected} rejected, ${outcome.unavailable} unavailable`;
      return redirectWithBanner(back, outcome.eventType, detail);
    })(context),
  );

  return app;
}

async function formBody(context: Context): Promise<Record<string, unknown>> {
  try {
    return await context.req.parseBody();
  } catch {
    return {};
  }
}

function redirectWithBanner(path: string, eventType: string, detail?: string): Response {
  const query = new URLSearchParams({ done: eventType });
  if (detail) query.set("detail", detail);
  return new Response(null, { status: 303, headers: { Location: `${path}?${query.toString()}` } });
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function pageContext(stores: SurfaceStores, enrollments: Map<string, RepositoryEnrollment> | undefined, banner: PageContext["banner"]): PageContext {
  const metadata = stores.queue.metadata();
  return {
    queuePath: metadata.databasePath,
    controlPlanePath: stores.controlPlanePath,
    schemaVersion: metadata.schemaVersion,
    lastEventSequence: metadata.lastEventSequence,
    repositories: sidebarFromEnrollments(stores.queue, enrollments),
    banner,
  };
}

/**
 * The one-line result banner after a redirect: `?done=<event type>` names
 * what was recorded and an optional `detail` adds counts. Both are validated
 * to short plain strings; anything else is ignored rather than rendered.
 */
function bannerFromQuery(context: Context): PageContext["banner"] {
  const done = context.req.query("done");
  if (!done || !/^[a-z][a-z.-]{1,40}$/.test(done)) return undefined;
  const detail = context.req.query("detail");
  const safeDetail = detail && /^[\w .,:;#()\/-]{1,160}$/.test(detail) ? detail : undefined;
  return { tone: "ok", text: `Recorded ${done}${safeDetail ? ` — ${safeDetail}` : ""}.` };
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
