import { createReadStream, existsSync } from "node:fs";

import { playwright } from "@vitest/browser-playwright";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const REFERENCE_EXE = new URL("../../reference/GameOfRobot.exe", import.meta.url);

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

export default defineConfig({
  base: "./",
  plugins: [referenceExe()],
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
