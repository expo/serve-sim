import type { IncomingMessage, ServerResponse } from "http";
import {
  allPermissionNames,
  applyPermission,
  isBundleId,
  listPermissions,
  resolvePermission,
  type PermissionStatus,
} from "./permissions";

const MAX_BODY_BYTES = 16 * 1024;
const ACTIONS = ["grant", "revoke", "reset"] as const;
export type PermissionAction = (typeof ACTIONS)[number];

export type PermissionsRouteDeps = {
  list: (udid: string, bundleId: string) => PermissionStatus[];
  apply: (udid: string, bundleId: string, permission: string, action: PermissionAction) => void;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function failure(res: ServerResponse, status: number, error: string): void {
  json(res, status, { ok: false, error });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Resolves `null` when the body exceeds the cap. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += typeof chunk === "string" ? chunk : chunk.toString();
      if (body.length > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
  });
}

function isAction(value: unknown): value is PermissionAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

/**
 * `GET ?bundleId=` lists one app's permissions; `POST {bundleId, id, action}`
 * changes one (or resets `all`) and replies with the fresh list. Both need a
 * simulator UDID, resolved by the caller from `?device=`.
 */
export function createPermissionsHandler(
  deps: PermissionsRouteDeps = { list: listPermissions, apply: applyPermission },
) {
  const respondWithList = (res: ServerResponse, udid: string, bundleId: string) => {
    try {
      json(res, 200, { ok: true, bundleId, permissions: deps.list(udid, bundleId) });
    } catch (error) {
      failure(res, 500, message(error));
    }
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    udid: string | null,
    query: URLSearchParams,
  ): Promise<void> => {
    if (req.method !== "GET" && req.method !== "POST") {
      return failure(res, 405, "method not allowed");
    }
    if (!udid) return failure(res, 400, "device must be a simulator UDID");
    if (req.method === "GET") {
      const bundleId = query.get("bundleId") ?? "";
      if (!isBundleId(bundleId)) return failure(res, 400, "bundleId is invalid");
      return respondWithList(res, udid, bundleId);
    }
    if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
      return failure(res, 415, "Unsupported Media Type");
    }
    if (!sameOrigin(req)) return failure(res, 403, "Cross-origin request blocked");
    const body = await readBody(req);
    if (body === null) return failure(res, 413, "Payload Too Large");
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return failure(res, 400, "payload must be JSON");
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return failure(res, 400, "payload must be an object");
    }
    const { bundleId, id, action } = payload as Record<string, unknown>;
    if (typeof bundleId !== "string" || !isBundleId(bundleId)) {
      return failure(res, 400, "bundleId is invalid");
    }
    if (!isAction(action)) return failure(res, 400, "action must be grant, revoke, or reset");
    const known = typeof id === "string" && (resolvePermission(id) || (id === "all" && action === "reset"));
    if (!known) {
      return failure(
        res,
        400,
        `id must be one of ${allPermissionNames().join(", ")}, or all with reset`,
      );
    }
    try {
      deps.apply(udid, bundleId, id as string, action);
    } catch (error) {
      return failure(res, 500, message(error));
    }
    respondWithList(res, udid, bundleId);
  };
}
