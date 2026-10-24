import { buildServer } from "./index.js";

const app = await buildServer();
const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "127.0.0.1";
await app.listen({ port, host });
console.log(`Web Agents To API listening on http://${host}:${port}`);