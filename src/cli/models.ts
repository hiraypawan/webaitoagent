import { ensureServer, listModels } from "./client.js";

async function main(): Promise<void> {
  if (!(await ensureServer({ quiet: true }))) process.exit(1);
  const models = await listModels();
  if (models.length === 0) {
    console.log("(no models)");
    return;
  }
  for (const model of models) console.log(`${model.id}  [${model.owned_by}]`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
