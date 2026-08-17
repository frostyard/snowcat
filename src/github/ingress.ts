import { Hono } from "hono";

import {
  GitHubDeliveryAcceptanceFailure,
  type GitHubPullRequestDeliveryInput,
} from "../control/store.ts";
import {
  GITHUB_WEBHOOK_MAXIMUM_BODY_BYTES,
  GitHubWebhookFailure,
  verifyAndNormalizeGitHubPullRequestWebhook,
} from "./webhook.ts";

export interface GitHubWebhookIngressOptions {
  appId: string;
  secret: Uint8Array;
  store: {
    recordVerifiedGitHubPullRequestDelivery(input: GitHubPullRequestDeliveryInput): unknown;
  };
}

export function createGitHubWebhookIngress(options: GitHubWebhookIngressOptions): Hono {
  const app = new Hono();
  const secret = Uint8Array.from(options.secret);

  app.post("/", async (context) => {
    try {
      const body = await readBoundedBody(context.req.raw);
      const input = verifyAndNormalizeGitHubPullRequestWebhook({
        appId: options.appId,
        secret,
        deliveryGuid: context.req.header("X-GitHub-Delivery") ?? "",
        event: context.req.header("X-GitHub-Event") ?? "",
        signature: context.req.header("X-Hub-Signature-256") ?? "",
        contentType: context.req.header("Content-Type") ?? "",
        body,
      });
      options.store.recordVerifiedGitHubPullRequestDelivery(input);
      return context.json({ status: "accepted" }, 202);
    } catch (error) {
      if (error instanceof GitHubWebhookFailure) {
        const status = webhookFailureStatus(error);
        return context.json({ error: error.code }, status);
      }
      if (error instanceof GitHubDeliveryAcceptanceFailure) {
        const status = error.code === "clock-regression" ? 503 : 409;
        return context.json({ error: error.code }, status);
      }
      return context.json({ error: "persistence-unavailable" }, 503);
    }
  });

  app.all("/", (context) => {
    context.header("Allow", "POST");
    return context.json({ error: "method-not-allowed" }, 405);
  });

  return app;
}

async function readBoundedBody(request: Request): Promise<Uint8Array> {
  const contentLength = request.headers.get("Content-Length");
  let declaredLength: number | undefined;
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new GitHubWebhookFailure("invalid-headers");
    }
    declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength)) {
      throw new GitHubWebhookFailure("invalid-headers");
    }
    if (declaredLength > GITHUB_WEBHOOK_MAXIMUM_BODY_BYTES) {
      throw new GitHubWebhookFailure("body-too-large");
    }
  }

  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > GITHUB_WEBHOOK_MAXIMUM_BODY_BYTES) {
        await reader.cancel();
        throw new GitHubWebhookFailure("body-too-large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (declaredLength !== undefined && total !== declaredLength) {
    throw new GitHubWebhookFailure("invalid-headers");
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function webhookFailureStatus(error: GitHubWebhookFailure): 400 | 401 | 413 | 422 | 503 {
  switch (error.code) {
    case "invalid-configuration":
      return 503;
    case "authentication-failed":
      return 401;
    case "body-too-large":
      return 413;
    case "unsupported-event":
    case "unsupported-action":
    case "unsupported-pull-request-shape":
      return 422;
    case "invalid-headers":
    case "malformed-payload":
      return 400;
  }
}
