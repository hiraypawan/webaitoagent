import { buildServer } from "./index.js";
import { config, isInsecureExposure, isLoopbackHost } from "../config/index.js";
import { log } from "../core/logger.js";

/** Is something already serving *our* API on this port? */
async function probeExisting(
  host: string,
  port: number
): Promise<{ version?: string } | undefined> {
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  try {
    const response = await fetch(`http://${probeHost}:${port}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { ok?: boolean; version?: string };
    return body?.ok ? { version: body.version } : undefined;
  } catch {
    return undefined;
  }
}
import { VERSION } from "../core/version.js";

async function main(): Promise<void> {
  if (isInsecureExposure()) {
    console.error(
      [
        "Refusing to start: HOST is not a loopback address and API_KEY is the shipped default.",
        "Anyone who can reach this port could use your logged-in AI account.",
        "",
        "Fix one of these:",
        "  - set HOST=127.0.0.1 (recommended)",
        "  - set a strong API_KEY",
        "  - set ALLOW_INSECURE=true to override (not recommended)",
      ].join("\n")
    );
    process.exit(1);
  }

  if (config.usingDefaultApiKey) {
    log.warn(
      "API_KEY is the default development key. Set a unique API_KEY in .env before exposing the server."
    );
  }
  if (!isLoopbackHost(config.host)) {
    log.warn(`Listening on ${config.host}: plain HTTP + Bearer token. Put it behind TLS or a tunnel.`);
  }

  const app = await buildServer();
  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      // Almost always the user started `npm run dev` twice. That is not a
      // failure worth a stack trace: say what is going on and exit cleanly.
      const existing = await probeExisting(config.host, config.port);
      await app.close().catch(() => undefined);
      if (existing) {
        console.log(
          [
            `The server is already running at http://${config.host}:${config.port}`,
            `  version ${existing.version ?? "unknown"}`,
            "",
            "Nothing to do: use the running instance, or stop it first.",
            "Nothing else needs starting — opencode talks to that instance.",
          ].join("\n")
        );
        process.exit(0);
      }
      console.error(
        [
          `Port ${config.port} is already used by another program.`,
          "",
          "Fix one of these:",
          `  - use a different port:  set PORT=8788   (then npm run dev)`,
          "  - find and stop the other program (on Windows: netstat -ano | findstr",
          `    :${config.port}, then taskkill /PID <pid> /F)`,
        ].join("\n")
      );
      process.exit(1);
    }
    app.log.error(error);
    process.exit(1);
  }

  console.log(
    [
      "",
      `web-agents-to v${VERSION}`,
      `  API      http://${config.host}:${config.port}/v1`,
      `  Health   http://${config.host}:${config.port}/health`,
      `  Login    npm run login -- --provider=mimo`,
      `  Chat     WEB repl        (one-shot: WEB chat "hi")`,
      `  Headless ${config.headless}`,
      "",
    ].join("\n")
  );

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    log.info(`Received ${signal}, shutting down...`);
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref?.();
    try {
      await app.close();
      process.exit(0);
    } catch {
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => log.error("unhandled rejection:", reason));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
