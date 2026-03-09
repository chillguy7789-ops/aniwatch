import https from "https";

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";

import { log } from "./config/logger.js";
import { corsConfig } from "./config/cors.js";
import { ratelimit } from "./config/ratelimit.js";
import { execGracefulShutdown } from "./utils.js";
import { DeploymentEnv, env, SERVERLESS_ENVIRONMENTS } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./config/errorHandler.js";
import type { ServerContext } from "./config/context.js";

import { hianimeRouter } from "./routes/hianime.js";
import { logging } from "./middleware/logging.js";
import { cacheConfigSetter, cacheControl } from "./middleware/cache.js";

import pkgJson from "../package.json" with { type: "json" };

const BASE_PATH = "/api/v2" as const;
const app = new Hono<ServerContext>();

// 1. GLOBAL MIDDLEWARE
app.use(logging);
app.use(corsConfig);
app.use(cacheControl);

/**
 * 2. STATIC FILES (THE SWACH FRONTEND)
 * We move this to the top so it intercepts requests to "/" 
 * and serves index.html from your public folder.
 */
app.use("/", serveStatic({ root: "public" }));
app.use("/index.html", serveStatic({ path: "./public/index.html" }));

/**
 * 3. SWACH MANIFEST REWRITER
 */
function rewriteManifest(manifest: string, proxyBase: string, targetBase: string) {
  return manifest.replace(/^(?!http|#)(.*)$/gm, (match) => {
    const fullUrl = match.startsWith('/') ? new URL(match, targetBase).href : targetBase + match;
    return `${proxyBase}?url=${encodeURIComponent(fullUrl)}`;
  });
}

/**
 * 4. SWACH CUSTOM PLAYER PROXY
 */
app.get('/swach/proxy', async (c) => {
  const streamUrl = c.req.query('url');
  const referer = c.req.query('referer') || 'https://hianime.to/';

  if (!streamUrl) return c.text('No URL provided', 400);

  try {
    const urlObj = new URL(streamUrl);
    const targetBase = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

    const response = await fetch(streamUrl, {
      headers: {
        'Referer': referer,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': '*/*',
      }
    });

    const isManifest = streamUrl.includes('.m3u8');

    if (isManifest) {
      let manifestText = await response.text();
      const rewritten = rewriteManifest(
        manifestText, 
        `https://aniwatch-g3v0.onrender.com/swach/proxy`, 
        targetBase
      );
      
      return c.text(rewritten, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        }
      });
    } else {
      return c.body(response.body as any, {
        status: response.status as any,
        headers: {
          'Content-Type': response.headers.get('Content-Type') || 'video/mp2t',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=3600',
        }
      });
    }
  } catch (err: any) {
    log.error(`Proxy Error: ${err.message}`);
    return c.text("Proxy Error: " + err.message, 500);
  }
});

// 5. API ROUTES
const isPersonalDeployment = Boolean(env.ANIWATCH_API_HOSTNAME);
if (isPersonalDeployment) {
    app.use(ratelimit);
}

app.get("/health", (c) => c.text("daijoubu", { status: 200 }));
app.get("/v", async (c) =>
    c.text(
        `aniwatch-api: v${"version" in pkgJson && pkgJson?.version ? pkgJson.version : "-1"}\n` +
            `aniwatch-package: v${"dependencies" in pkgJson && pkgJson?.dependencies?.aniwatch ? pkgJson?.dependencies?.aniwatch : "-1"}`
    )
);

app.use(cacheConfigSetter(BASE_PATH.length));
app.basePath(BASE_PATH).route("/hianime", hianimeRouter);

app.notFound(notFoundHandler);
app.onError(errorHandler);

// 6. SERVER EXECUTION
(function () {
    if (SERVERLESS_ENVIRONMENTS.includes(env.ANIWATCH_API_DEPLOYMENT_ENV)) {
        return;
    }

    const server = serve({
        port: env.ANIWATCH_API_PORT,
        fetch: app.fetch,
    }).addListener("listening", () =>
        log.info(
            `aniwatch-api RUNNING at http://localhost:${env.ANIWATCH_API_PORT}`
        )
    );

    process.on("SIGINT", () => execGracefulShutdown(server));
    process.on("SIGTERM", () => execGracefulShutdown(server));
    process.on("uncaughtException", (err) => {
        log.error(`Uncaught Exception: ${err.message}`);
        execGracefulShutdown(server);
    });
    process.on("unhandledRejection", (reason, promise) => {
        log.error(
            `Unhandled Rejection at: ${promise}, reason: ${reason instanceof Error ? reason.message : reason}`
        );
        execGracefulShutdown(server);
    });

    if (
        isPersonalDeployment &&
        env.ANIWATCH_API_DEPLOYMENT_ENV === DeploymentEnv.RENDER
    ) {
        const INTERVAL_DELAY = 8 * 60 * 1000; // 8mins
        const url = new URL(`https://${env.ANIWATCH_API_HOSTNAME}/health`);
        setInterval(() => {
            https.get(url.href).on("response", () => {
                log.info(`aniwatch-api HEALTH_CHECK at ${new Date().toISOString()}`);
            }).on("error", (err) =>
                log.warn(`aniwatch-api HEALTH_CHECK failed; ${err.message.trim()}`)
            );
        }, INTERVAL_DELAY);
    }
})();

export default app;
