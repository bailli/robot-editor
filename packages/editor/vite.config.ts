import { spawn } from "node:child_process";
import { createReadStream, existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { playwright } from "@vitest/browser-playwright";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const ROOT = new URL("../../", import.meta.url);
const REFERENCE_EXE = new URL("reference/GameOfRobot.exe", ROOT);
const HARNESS = new URL("tools/wine/harness.py", ROOT);
const PLAY_EXE = new URL(".wine/play.exe", ROOT);
const MAX_EXE_BYTES = 8 << 20; // the game's exe has about 2 MB
/** How long the harness has to refuse playing before the game counts as started. */
const PLAY_REFUSAL_MS = 1000;

/** In development, serves reference/GameOfRobot.exe (see README) so it opens by itself. */
function referenceExe(): Plugin {
  return {
    name: "reference-exe",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/reference/GameOfRobot.exe", (_, res, next) => {
        if (!existsSync(REFERENCE_EXE)) {
          next();
          return;
        }
        res.setHeader("Content-Type", "application/octet-stream");
        createReadStream(REFERENCE_EXE).pipe(res);
      });
    },
  };
}

/**
 * In development, POST /play?episode=N with an exe runs it in the game under Wine on
 * this display (tools/wine/harness.py play): the editor's "Test in game". Only the
 * editor's own page may: any other site open in the browser could post an exe here too.
 */
function playInWine(): Plugin {
  return {
    name: "play-in-wine",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/play", (req, res) => {
        const episode = Number(
          new URL(req.url ?? "", "http://localhost").searchParams.get("episode"),
        );
        const fail = (status: number, text: string) => {
          res.statusCode = status;
          res.end(text);
        };
        if (req.method !== "POST" || !Number.isInteger(episode) || episode < 0 || episode > 4) {
          fail(400, "POST an exe to /play?episode=0..4");
          return;
        }
        const origin = req.headers.origin;
        if (origin === undefined || URL.parse(origin)?.host !== req.headers.host) {
          fail(403, "only the editor's page may run the game");
          return;
        }
        if (!existsSync(new URL(".wine/prefix/", ROOT))) {
          fail(503, "no Wine prefix: run python3 tools/wine/harness.py setup");
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_EXE_BYTES) {
            fail(413, "not the game's exe: too large");
            req.destroy();
          } else chunks.push(chunk);
        });
        req.on("end", () => {
          writeFileSync(PLAY_EXE, Buffer.concat(chunks));
          const args = ["-I", fileURLToPath(HARNESS), "play", String(episode)];
          const game = spawn("python3", [...args, "--exe", fileURLToPath(PLAY_EXE)], {
            detached: true,
            stdio: ["ignore", "ignore", "pipe"],
          });
          let errors = "";
          game.stderr.on("data", (chunk: Buffer) => {
            errors += chunk.toString();
          });
          // the harness refuses at once (setup unfinished, no DISPLAY): the editor says why
          const started = setTimeout(() => {
            res.statusCode = 202;
            res.end();
          }, PLAY_REFUSAL_MS);
          const failed = (text: string) => {
            server.config.logger.error(`play: ${text}`);
            if (res.writableEnded) return;
            clearTimeout(started);
            fail(500, text);
          };
          game.on("error", (error) => {
            failed(error.message);
          });
          game.on("exit", (code) => {
            if (code !== 0) failed(errors.trim() || `the harness ended with code ${String(code)}`);
          });
          game.unref();
        });
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [referenceExe(), playInWine()],
  test: {
    name: "editor",
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000, // drawing every room of the game
    browser: {
      enabled: true,
      headless: true,
      viewport: { width: 1500, height: 900 }, // a desktop editor
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
