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
 * this display (tools/wine/harness.py play): the editor's "Test in game".
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
        if (!existsSync(new URL(".wine/prefix/", ROOT))) {
          fail(503, "no Wine prefix: run python3 tools/wine/harness.py setup");
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          writeFileSync(PLAY_EXE, Buffer.concat(chunks));
          const args = ["-I", fileURLToPath(HARNESS), "play", String(episode)];
          const game = spawn("python3", [...args, "--exe", fileURLToPath(PLAY_EXE)], {
            detached: true,
            stdio: "ignore",
          });
          game.on("error", (error) => {
            server.config.logger.error(`play: ${error.message}`);
          });
          game.unref();
          res.statusCode = 202;
          res.end();
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
