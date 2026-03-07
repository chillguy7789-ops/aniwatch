import { Hono } from "hono";

const proxyRouter = new Hono();

// Handle preflight for null-origin local file requests
proxyRouter.options("/m3u8", (c) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
});

proxyRouter.get("/m3u8", async (c) => {
  const url = c.req.query("url");
  const referer = c.req.query("referer") || "https://megacloud.tv/";

  if (!url) return c.text("Missing url param", 400);

  try {
    const res = await fetch(url, {
      headers: {
        "Referer": referer,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Origin": new URL(referer).origin,
      },
    });

    const text = await res.text();
    return new Response(text, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  } catch (e: any) {
    return c.text("Proxy error: " + e.message, 500);
  }
});

export { proxyRouter };