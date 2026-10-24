import "dotenv/config";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  headless: (process.env.HEADLESS ?? "true").toLowerCase() === "true",
  profileRoot: process.env.PROFILE_ROOT?.trim() || undefined,
  mimoUser: process.env.MIMO_USER,
  mimoPass: process.env.MIMO_PASS,
  apiKey: process.env.API_KEY ?? "web-agents-to",
};