// Cloudflare Pages Function: /homes, /homes/<city> and /homes/<city>/<area>: listings by city and area.
import { servePublic } from "../../netlify/lib/server.mjs";

export const onRequest = (context) => servePublic(context.request, context.env);
