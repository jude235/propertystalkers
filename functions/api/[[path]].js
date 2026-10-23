// Cloudflare Pages Function serving every /api/* request.
import { serve } from "../../netlify/lib/server.mjs";

export const onRequest = (context) => serve(context.request, context.env);
