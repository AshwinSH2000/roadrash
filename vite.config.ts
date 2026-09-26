import { defineConfig, type Plugin } from "vite";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Phone testing needs HTTPS on the LAN — iOS gates `DeviceOrientationEvent`
 * (tilt steering) behind a secure context, and that check isn't relaxed for
 * a plain-HTTP LAN address the way it is for localhost. Generate the pair
 * with `mkcert .certs/dev-cert.pem .certs/dev-key.pem localhost 127.0.0.1
 * <lan-ip>` (see README); absent, the dev server just falls back to HTTP.
 */
const certFile = join(__dirname, ".certs/dev-cert.pem");
const keyFile = join(__dirname, ".certs/dev-key.pem");
const devHttps =
  existsSync(certFile) && existsSync(keyFile)
    ? { cert: readFileSync(certFile), key: readFileSync(keyFile) }
    : undefined;

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
  server: {
    https: devHttps,
    host: true,
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
