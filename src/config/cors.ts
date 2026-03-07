import { cors } from "hono/cors";

export const corsConfig = cors({
    allowMethods: ["GET", "OPTIONS"],
    maxAge: 600,
    credentials: false,
    origin: "*",
});