import { parseArgs } from "node:util";
import { ensureServer, logout } from "./client.js";

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: { provider: { type: "string" } },
  }).values;

  const provider = parsed.provider ?? "mimo";
  if (!(await ensureServer({ quiet: true }))) process.exit(1);

  try {
    console.log(await logout(provider));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
