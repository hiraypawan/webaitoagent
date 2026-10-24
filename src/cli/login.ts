import { config } from "../config/index.js";

const base = process.env.BASE_URL ?? `http://${config.host}:${config.port}`;
const apiKey = config.apiKey;
const provider = process.argv.find((a) => a.startsWith("--provider="))?.split("=")[1] ?? "mimo";

async function main() {
  const res = await fetch(base + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ provider }),
  });
  console.log(await res.text());
  console.log("A browser window should open. Log in, then close it.");
}

main().catch((e) => { console.error(e); process.exit(1); });