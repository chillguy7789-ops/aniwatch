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

// 1. Initialize the app
const app = new Hono<ServerContext>();

// 2. Attach Global Middleware
app.use(logging);
app.use(corsConfig);
app.use(cacheControl);

/**
 * SWACH MANIFEST REWRITER
 * This function intercepts the .m3u8 file and rewrites the segment URLs
 * so they all go through your proxy instead of being blocked by the host.
 */
function rewriteManifest(manifest: string, proxyBase: string, targetBase: string) {
  return manifest.replace(/^(?!http|#)(.*)$/gm, (match) => {
    // If the line is a relative path, we make it absolute and wrap it in our proxy
    const fullUrl = match.startsWith('/') ? new URL(match, targetBase).href : targetBase + match;
    return `${proxyBase}?url=${encodeURIComponent(fullUrl)}`;
  });
}

/**
 * SWACH CUSTOM PLAYER PROXY (Version 4.0 - Manifest Aware)
 */
app.get('/swach/proxy', async (c) => {
  const streamUrl = c.req.query('url');
  const referer = c.req.query('referer') || 'https://hianime.to/';

  if (!streamUrl) return c.text('No URL provided', 400);

  try {
    const urlObj = new URL(streamUrl);
    // Determine the base path for relative segments in the .m3u8
    const targetBase = urlObj.origin + urlObj.pathname.substring(0, urlObj.pathname.lastIndexOf('/') + 1);

    const response = await fetch(streamUrl, {
      headers: {
        'Referer': referer,
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
        'Accept': '*/*',
      }
    });

    // Check if we're dealing with a manifest (M3U8) or a video segment (TS)
    const isManifest = streamUrl.includes('.m3u8');

    if (isManifest) {
      let manifestText = await response.text();
      // Rewrite the manifest so every segment link points back to THIS proxy
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
      // It's a video segment (.ts file), pipe it directly as binary
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

/*
    CAUTION: 
    Having the "ANIWATCH_API_HOSTNAME" env will
    enable rate limitting for the deployment.
*/
const isPersonalDeployment = Boolean(env.ANIWATCH_API_HOSTNAME);
if (isPersonalDeployment) {
    app.use(ratelimit);
}

app.use("/", serveStatic({ root: "public" }));

app.get("/health", (c) => c.text("daijoubu", { status: 200 }));
app.get("/v", async (c) =>
    c.text(
        `aniwatch-api: v${"version" in pkgJson && pkgJson?.version ? pkgJson.version : "-1"}\n` +
            `aniwatch-package: v${"dependencies" in pkgJson && pkgJson?.dependencies?.aniwatch ? pkgJson?.dependencies?.aniwatch : "-1"}`
    )
);

app.use(cacheConfigSetter(BASE_PATH.length));

// Routes
app.basePath(BASE_PATH).route("/hianime", hianimeRouter);
app.basePath(BASE_PATH).get("/anicrush", (c) =>
    c.text("Anicrush could be implemented in future.")
);

app.notFound(notFoundHandler);
app.onError(errorHandler);

// Server Execution
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

    // Render Anti-Sleep Logic
    if (
        isPersonalDeployment &&
        env.ANIWATCH_API_DEPLOYMENT_ENV === DeploymentEnv.RENDER
    ) {
        const INTERVAL_DELAY = 8 * 60 * 1000; // 8mins
        const url = new URL(`https://${env.ANIWATCH_API_HOSTNAME}/health`);

        setInterval(() => {
            https
                .get(url.href)
                .on("response", () => {
                    log.info(
                        `aniwatch-api HEALTH_CHECK at ${new Date().toISOString()}`
                    );
                })
                .on("error", (err) =>
                    log.warn(
                        `aniwatch-api HEALTH_CHECK failed; ${err.message.trim()}`
                    )
                );
        }, INTERVAL_DELAY);
    }
})();

export default app;
