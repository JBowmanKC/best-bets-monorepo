/**
 * Standalone runner for the Vercel function handlers.
 *
 * NOT needed for normal development — `npm run dev` serves the API from inside
 * Vite (see the `localApi` plugin in apps/web/vite.config.ts), so there is no
 * separate port to manage. Use this when you want the API without the frontend,
 * e.g. for curl/Postman testing or pointing another client at it.
 *
 *   npm run dev:api                # uses DEFAULT_PORT, falls back if taken
 *   API_PORT=4000 npm run dev:api  # pin a specific port
 */
import { createServer } from "node:http";
import {
  API_ROUTES, REPO_ROOT, loadEnvFiles, missingEnv, invokeHandler,
  type VercelLikeHandler,
} from "./api-shim.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Deliberately not 3000/3001/8080 — those collide with almost everything.
const DEFAULT_PORT = 4176;
const requestedPort = process.env.API_PORT ? Number(process.env.API_PORT) : DEFAULT_PORT;

loadEnvFiles();

// Imported after loadEnvFiles() so module-scope process.env reads see the values.
const handlers = new Map<string, VercelLikeHandler>();
for (const [route, modulePath] of Object.entries(API_ROUTES)) {
  const mod = await import(pathToFileURL(resolve(REPO_ROOT, modulePath)).href);
  handlers.set(route, mod.default as VercelLikeHandler);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const handler = handlers.get(url.pathname);

  if (!handler) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({
      error:   "Not found",
      message: `No local function for ${url.pathname}. Known routes: ${Object.keys(API_ROUTES).join(", ")}`,
    }));
    return;
  }

  await invokeHandler(handler, req, res, url);
});

function announce() {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : requestedPort;

  console.log(`\n  API  →  http://localhost:${port}`);
  for (const route of Object.keys(API_ROUTES)) {
    console.log(`         http://localhost:${port}${route}`);
  }

  const missing = missingEnv();
  if (missing.length) {
    console.log(`  ⚠️  Missing env vars: ${missing.join(", ")} (add them to .env.local)`);
  }
  console.log("");
}

server.once("error", (err: NodeJS.ErrnoException) => {
  if (err.code !== "EADDRINUSE") throw err;

  if (process.env.API_PORT) {
    // An explicitly requested port was taken — don't silently move.
    console.error(
      `\n  ✖ Port ${requestedPort} (from API_PORT) is already in use.\n` +
      `    Find it:  lsof -nP -iTCP:${requestedPort} -sTCP:LISTEN\n` +
      `    Or unset API_PORT to let the OS pick a free port.\n`
    );
    process.exit(1);
  }

  console.warn(`  ℹ Port ${requestedPort} is busy — falling back to a free port.`);
  server.listen(0, announce);
});

server.listen(requestedPort, announce);
