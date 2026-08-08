/**
 * Shared plumbing for running the Vercel function handlers locally.
 *
 * In production Vercel discovers `api/*.ts` and runs each file as an isolated
 * serverless function. Locally we emulate just enough of that contract to run
 * the same handler source unmodified — used by both the Vite dev middleware
 * (apps/web/vite.config.ts) and the standalone runner (scripts/dev-api.mts).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Request path → handler module, relative to the repo root. */
export const API_ROUTES: Record<string, string> = {
  "/api/best-bets": "api/best-bets.ts",
  "/api/resolve-results": "api/resolve-results.ts",
};

export const REQUIRED_ENV = ["ODDS_API_KEY"] as const;

export type VercelLikeHandler = (req: never, res: never) => unknown | Promise<unknown>;

// ─── Env loading ─────────────────────────────────────────────────────────────
/**
 * Handlers read `process.env` at module scope, so this must run before the
 * handler module is imported. Existing environment variables always win.
 */
export function loadEnvFiles(root = REPO_ROOT, files = [".env.local", ".env"]) {
  for (const file of files) {
    const path = resolve(root, file);
    if (!existsSync(path)) continue;

    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Strip matching surrounding quotes.
      if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

export function missingEnv(): string[] {
  return REQUIRED_ENV.filter(k => !process.env[k]);
}

// ─── Minimal VercelRequest / VercelResponse shim ─────────────────────────────
function applyShim(req: IncomingMessage, res: ServerResponse, url: URL) {
  const query: Record<string, string | string[]> = {};
  for (const key of url.searchParams.keys()) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length > 1 ? all : all[0];
  }

  const vercelReq = Object.assign(req, { query, cookies: {}, body: undefined });

  const vercelRes = Object.assign(res, {
    status(code: number) {
      res.statusCode = code;
      return vercelRes;
    },
    json(payload: unknown) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(payload));
      return vercelRes;
    },
    send(payload: string) {
      res.end(payload);
      return vercelRes;
    },
  });

  return { vercelReq, vercelRes };
}

// ─── Invocation ──────────────────────────────────────────────────────────────
/**
 * Run `handler` against a Node request/response pair, emulating the Vercel
 * request contract. Never throws — handler errors become a 500 JSON body.
 */
export async function invokeHandler(
  handler: VercelLikeHandler,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
) {
  const started = Date.now();
  const { vercelReq, vercelRes } = applyShim(req, res, url);

  try {
    // The shim is structural, not a real VercelRequest/VercelResponse.
    await handler(vercelReq as never, vercelRes as never);
  } catch (err) {
    console.error(`[api] unhandled error in ${url.pathname}:`, err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({
        error:   "Handler threw",
        message: err instanceof Error ? err.message : String(err),
      }));
    }
  } finally {
    console.log(`[api] ${req.method} ${url.pathname}${url.search} → ${res.statusCode} (${Date.now() - started}ms)`);
  }
}
