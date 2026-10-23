// Netlify Function serving every /api/* request.
import { serve } from "../lib/server.mjs";

export default async (req) => serve(req, process.env);

export const config = { path: "/api/*" };
