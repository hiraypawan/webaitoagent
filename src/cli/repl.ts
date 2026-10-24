import readline from "node:readline";
import { chat, ensureServer, listModels } from "./client.js";
import type { ChatMessage } from "../core/types.js";

const HELP = `Commands:
  /model <id>   switch model
  /models       list available models
  /clear        forget the conversation history
  /help         show this help
  /exit         quit`;

async function main(): Promise<void> {
  if (!(await ensureServer())) process.exit(1);

  let model = process.env.MODEL ?? "mimo/mimo-v2.6-pro";
  const history: ChatMessage[] = [];

  console.log("web-agents-to — interactive chat");
  console.log(`Model: ${model}`);
  console.log(HELP);
  console.log("--------------------------------------------------");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "You> ",
  });

  let busy = false;
  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (busy) return;
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/exit" || input === "/quit") {
      rl.close();
      return;
    }
    if (input === "/help") {
      console.log(HELP);
      rl.prompt();
      return;
    }
    if (input === "/clear") {
      history.length = 0;
      console.log("History cleared.");
      rl.prompt();
      return;
    }
    if (input === "/models") {
      try {
        const models = await listModels();
        console.log(models.map((item) => item.id).join("\n") || "(no models)");
      } catch (error) {
        console.error(error instanceof Error ? error.message : error);
      }
      rl.prompt();
      return;
    }
    if (input.startsWith("/model ")) {
      model = input.slice(7).trim();
      console.log(`Model set to ${model}`);
      rl.prompt();
      return;
    }
    if (input.startsWith("/")) {
      console.log("Unknown command. Try /help");
      rl.prompt();
      return;
    }

    busy = true;
    history.push({ role: "user", content: input });
    process.stdout.write("Assistant> ");
    try {
      const result = await chat({
        model,
        messages: history,
        onDelta: (text) => process.stdout.write(text),
      });
      history.push({ role: "assistant", content: result.content });
      process.stdout.write("\n");
    } catch (error) {
      console.error(`\n[error] ${error instanceof Error ? error.message : error}`);
      history.pop();
    } finally {
      busy = false;
      rl.prompt();
    }
  });

  rl.on("SIGINT", () => {
    process.stdout.write("\n");
    rl.close();
  });

  rl.on("close", () => {
    console.log("Bye.");
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
