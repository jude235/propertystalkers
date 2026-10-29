// Cloudflare Pages Function: /sitemap.xml, every listing the map shows to visitors.
import { servePublic } from "../netlify/lib/server.mjs";

export const onRequest = (context) => servePublic(context.request, context.env);
