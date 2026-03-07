import { cors } from "hono/cors";
import { env } from "./env.js";

export const corsConfig = cors({
    allowMethods: ["GET", "OPTIONS"],
    maxAge: 600,
    credentials: false,
    origin: "*",
});