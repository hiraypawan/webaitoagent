import { config } from "../config/index.js";

const base = process.env.BASE_URL ?? `http://${config.host}:${config.port}`;
const apiKey = config.apiKey;

const args = process.argv.slice(2);
const model = args.find((a) => a.startsWith("--model="))?.split("=")[1] ?? "mimo/mimo-v2.6-pro";
const prompt = args.filter((a) => !a.startsWith("--")).join(" ");

async function main() {
  if (!prompt) {
    console.log("Usage: npm run cli -- \"your prompt\" [--model=mimo/mimo-v2.6-pro]");
    console.log("Models: GET " + base + "/v1/models");
    return;
  }
  const res = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], stream: true }),
  });
  if (!res.ok) {
    console.error(await res.text());
    return;
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const j = JSON.parse(data);
        const c = j.choices?.[0]?.delta?.content;
        if (c) process.stdout.write(c);
      } catch {}
    }
  }
  process.stdout.write("\n");
}

main().catch((e) => { console.error(e); process.exit(1); });