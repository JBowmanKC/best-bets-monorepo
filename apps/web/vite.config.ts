import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import {
  REPO_ROOT, API_ROUTES, loadEnvFiles, missingEnv, invokeHandler,
  type VercelLikeHandler,
} from "../../scripts/api-shim.mjs";

/**
 * Serves the `api/*.ts` Vercel handlers directly from Vite's dev server.
 *
 * Running them in-process rather than on a separate port means there is no
 * second port to collide with another project, and no proxy target that can
 * silently point at someone else's server. Vite already picks the next free
 * port for itself, so several projects can run at once.
 *
 * Handlers are loaded through `ssrLoadModule`, so edits to api/*.ts take
 * effect on the next request without restarting the dev server.
 */
function localApi(): Plugin {
  return {
    name: "local-api",
    // Handlers read process.env at module scope — populate it before they load.
    config() {
      loadEnvFiles();
    },
    configureServer(server) {
      const missing = missingEnv();
      if (missing.length) {
        server.config.logger.warn(
          `[api] missing env vars: ${missing.join(", ")} — add them to .env.local`
        );
      }

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const modulePath = API_ROUTES[url.pathname];
        if (!modulePath) return next();

        try {
          const mod = await server.ssrLoadModule(resolve(REPO_ROOT, modulePath));
          await invokeHandler(mod.default as VercelLikeHandler, req, res, url);
        } catch (err) {
          // Failed to even load the handler module (syntax/import error).
          server.config.logger.error(`[api] failed to load ${modulePath}: ${err}`);
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify({
            error:   "Failed to load API handler",
            message: err instanceof Error ? err.message : String(err),
          }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localApi()],
  ssr: {
    // Vite inlines linked workspace deps into the SSR module graph by default,
    // which fails here because @best-bets/algorithm builds to CommonJS. Marking
    // it external hands it to Node, whose CJS/ESM interop loads it correctly.
    external: ["@best-bets/algorithm"],
  },
  server: {
    fs: {
      // api/ and packages/ live outside apps/web.
      allow: [REPO_ROOT],
    },
  },
});
