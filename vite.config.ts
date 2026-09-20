import { defineConfig, type Plugin } from "vite";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Dev-only sink for the game's telemetry (see `src/core/Telemetry.ts`). The
 * browser can't write files, so the game POSTs CSV rows here and they are
 * appended to `logs/telemetry-<session>.csv`, one file per page load.
 */
function telemetrySink(): Plugin {
  return {
    name: "roadrash-telemetry-sink",
    configureServer(server) {
      const dir = join(server.config.root, "logs");
      server.middlewares.use("/__telemetry", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url ?? "", "http://localhost");
        const session = (url.searchParams.get("session") ?? "session").replace(/[^A-Za-z0-9_-]/g, "");
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          try {
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            appendFileSync(join(dir, `telemetry-${session}.csv`), Buffer.concat(chunks));
            res.statusCode = 204;
          } catch (error) {
            res.statusCode = 500;
            res.end(String(error));
            return;
          }
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  root: ".",
  publicDir: "public",
  plugins: [telemetrySink()],
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
