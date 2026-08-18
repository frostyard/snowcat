import { Hono, type Context, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";

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
import { DEFAULT_STREAM_HEARTBEAT_MS, DEFAULT_STREAM_POLL_MS, STREAM_PAGE_SIZE, toStreamedEvent, type StreamOptions } from "./stream.ts";
import { boardPartial, boardPartials, type BoardPartial } from "./pages-repositories.ts";
import {
  ControlPlaneConflictError,
  ControlPlaneUnavailableError,
  GitHubListingError,
  applyImportIssues,
  applyRepositoryHold,
  applySeedDogfood,
} from "./repository-actions.ts";
import { inboxPartial, inboxPartials, type InboxPartial } from "./pages.ts";
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
  /** Event-stream cadence; tests shorten it. */
  stream?: StreamOptions;
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
    (context) =>
      page((stores, enrollments, chrome) => {
        const data = readInbox(stores.queue, enrollments);
        const partial = context.req.query("partial");
        if (partial !== undefined) {
          if (!(inboxPartials as readonly string[]).includes(partial)) return new Response("unknown partial", { status: 400 });
          return new Response(inboxPartial(data, partial as InboxPartial), htmlHeaders());
        }
        return new Response(inboxPage(chrome, data), htmlHeaders());
      })(context),
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
      const partial = context.req.query("partial");
      if (partial !== undefined) {
        if (!(boardPartials as readonly string[]).includes(partial)) return new Response("unknown partial", { status: 400 });
        return new Response(boardPartial(board, partial as BoardPartial), htmlHeaders());
      }
      return new Response(boardPage(chrome, board), htmlHeaders());
    })(context),
  );

  // Server-sent events: the ledger tail, identifying fields only. Session-
  // guarded like every surface route; polls eventsSince at a fixed cadence
  // and stops when the client goes away.
  app.get("/events/stream", requireConfigured, requireSession, (context) => {
    let stores: SurfaceStores;
    try {
      stores = options.stores();
    } catch (error) {
      return context.text(`The queue database could not be opened: ${message(error)}`, 503);
    }
    const repository = context.req.query("repository");
    if (repository !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/.test(repository)) {
      return context.text("repository must be owner/name", 400);
    }
    const pollMs = options.stream?.pollMs ?? DEFAULT_STREAM_POLL_MS;
    const heartbeatMs = options.stream?.heartbeatMs ?? DEFAULT_STREAM_HEARTBEAT_MS;
    return streamSSE(context, async (stream) => {
      const signal = context.req.raw.signal;
      const onAbort = () => stream.abort();
      signal.addEventListener("abort", onAbort, { once: true });
      let cursor = stores.queue.metadata().lastEventSequence;
      await stream.writeSSE({ event: "cursor", data: JSON.stringify({ sequence: cursor }) });
      let lastHeartbeat = Date.now();
      try {
        while (!stream.aborted && !stream.closed) {
          let page: ReturnType<QueueStore["eventsSince"]>;
          try {
            page = stores.queue.eventsSince(cursor, { repository, limit: STREAM_PAGE_SIZE });
          } catch {
            // The store went away under us (closed or unreadable): end the stream; the client reconnects.
            break;
          }
          while (page.length > 0 && !stream.aborted) {
            for (const event of page) {
              await stream.writeSSE({ event: "event", id: String(event.sequence), data: JSON.stringify(toStreamedEvent(event)) });
              cursor = event.sequence;
            }
            try {
              page = page.length === STREAM_PAGE_SIZE ? stores.queue.eventsSince(cursor, { repository, limit: STREAM_PAGE_SIZE }) : [];
            } catch {
              page = [];
            }
          }
          if (Date.now() - lastHeartbeat >= heartbeatMs) {
            await stream.write(": keep-alive\n\n");
            lastHeartbeat = Date.now();
          }
          await stream.sleep(pollMs);
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    });
  });

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

  // Repository actions from the board header: import labeled issues, seed
  // dogfood, impose or clear the operator hold — the CLI's repository-level
  // commands, one same-origin POST each. Failures re-render the board with a
  // banner; success redirects back with the result.
  app.post("/repositories/:owner/:name/:action{import-issues|seed-dogfood|hold|clear-hold}", requireConfigured, requireSession, requireSameOrigin, (context) =>
    page(async (stores, enrollments, chrome) => {
      const slug = `${context.req.param("owner")}/${context.req.param("name")}`;
      const action = context.req.param("action");
      const body = await formBody(context);
      const back = returnPath(body, repositoryPath(slug));
      const renderBoard = (banner: NonNullable<PageContext["banner"]>, status: number) => {
        // Re-read after the attempt so the board (and its enrollment badge) shows the current state.
        const board = readBoard(stores.queue, slug, readEnrollments(stores.controlPlanePath));
        if (!board) return new Response(notFoundPage(chrome, `${slug} is neither opted in to the queue nor declared in the control plane.`), htmlHeaders(404));
        return new Response(boardPage({ ...chrome, banner }, board), htmlHeaders(status));
      };
      let board;
      try {
        board = readBoard(stores.queue, slug, enrollments);
      } catch (error) {
        return new Response(notFoundPage(chrome, `No repository ${slug}: ${message(error)}`), htmlHeaders(404));
      }
      if (!board) return new Response(notFoundPage(chrome, `${slug} is neither opted in to the queue nor declared in the control plane.`), htmlHeaders(404));
      try {
        if (action === "import-issues") {
          if (!board.optedIn) throw new MutationInputError(`${slug} is not opted in to the queue; opt it in first.`);
          const outcome = await applyImportIssues(stores.queue, slug, body, stores.verifier?.fetcher);
          return redirectWithBanner(back, outcome.eventType, `${outcome.fetched} fetched, ${outcome.created} created, ${outcome.skipped} already imported`);
        }
        if (action === "seed-dogfood") {
          if (!board.optedIn) throw new MutationInputError(`${slug} is not opted in to the queue; opt it in first.`);
          const outcome = applySeedDogfood(stores.queue, slug, board.enrollment);
          const detail = [
            `${outcome.created.length} created${outcome.created.length > 0 ? ` (${outcome.created.join(", ")})` : ""}`,
            `${outcome.skippedKinds.length} active`,
            `${outcome.cooledKinds.length} cooling`,
            ...(outcome.undeclaredKinds.length > 0 ? [`${outcome.undeclaredKinds.length} not declared`] : []),
            ...(outcome.unsupportedPrograms.length > 0 ? [`no catalog entry yet: ${outcome.unsupportedPrograms.join(", ")}`] : []),
          ].join(", ");
          return redirectWithBanner(back, outcome.eventType, detail);
        }
        const outcome = applyRepositoryHold(stores.controlPlanePath, slug, action === "hold" ? "impose" : "clear", body);
        return redirectWithBanner(back, outcome.eventType, `${slug} is now ${outcome.effectiveState}`);
      } catch (error) {
        const label = action.replace("-", " ");
        if (error instanceof ControlPlaneConflictError) {
          return renderBoard({ tone: "error", text: `The control plane changed while ${label} was being recorded; nothing was changed — try again from the current state.` }, 409);
        }
        if (error instanceof ControlPlaneUnavailableError) return renderBoard({ tone: "error", text: `${capitalize(label)} is unavailable: ${error.message}` }, 503);
        if (error instanceof GitHubListingError) return renderBoard({ tone: "error", text: `${capitalize(label)} did not run: ${error.message}` }, 502);
        const status = error instanceof MutationInputError ? 400 : 409;
        return renderBoard({ tone: "error", text: `${capitalize(label)} was not applied: ${message(error)}` }, status);
      }
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
