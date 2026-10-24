import { parseArgs } from "node:util";
import { chat, ensureServer } from "./client.js";

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        model: { type: "string" },
        json: { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : error}\n`);
    console.error('Usage: npm run cli -- "your prompt" [--model=mimo/mimo-v2.6-pro] [--json]');
    process.exitCode = 1;
    return;
  }

  if (parsed.values.help) {
    console.log('Usage: npm run cli -- "your prompt" [--model=mimo/mimo-v2.6-pro] [--json]');
    return;
  }

  const prompt = parsed.positionals.join(" ").trim();
  if (!prompt) {
    console.log('Usage: npm run cli -- "your prompt" [--model=mimo/mimo-v2.6-pro] [--json]');
    console.log("Interactive chat: WEB repl");
    return;
  }

  if (!(await ensureServer({ quiet: true }))) process.exit(1);

  const model = parsed.values.model ?? "mimo/mimo-v2.6-pro";
  try {
    const result = await chat({
      model,
      messages: [{ role: "user", content: prompt }],
      onDelta: parsed.values.json ? undefined : (text) => process.stdout.write(text),
    });
    if (parsed.values.json) {
      console.log(JSON.stringify({ model, content: result.content }, null, 2));
    } else {
      process.stdout.write("\n");
    }
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
