import { parseArgs } from "node:util";
import { ensureServer, login } from "./client.js";

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        provider: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch {
    parsed = undefined as never;
  }

  if (!parsed || parsed.values.help) {
    console.log("Usage: npm run login -- [--provider=mimo]\nOpens a visible browser; sign in, then close the window.");
    return;
  }

  const provider = parsed.values.provider ?? "mimo";
  if (!(await ensureServer({ quiet: true }))) process.exit(1);

  try {
    console.log(await login(provider));
    console.log("Sign in in the browser window, then close it. The session is saved for the server.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
