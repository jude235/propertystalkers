// Cloudflare Pages Function: /developer/<name>: one developer's projects.
import { servePublic } from "../../netlify/lib/server.mjs";

export const onRequest = (context) => servePublic(context.request, context.env);
