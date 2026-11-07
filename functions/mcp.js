// Cloudflare Pages Function: the Property Stalkers connector for Claude (MCP) at /mcp.
import { serveMcp } from "../netlify/lib/server.mjs";

export const onRequest = (context) => serveMcp(context.request, context.env, context);
