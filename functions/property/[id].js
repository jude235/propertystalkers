// Cloudflare Pages Function: the public page for one listing, /property/<id>.
import { servePublic } from "../../netlify/lib/server.mjs";

export const onRequest = (context) => servePublic(context.request, context.env);
