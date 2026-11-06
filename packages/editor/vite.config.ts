import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

import { playwright } from "@vitest/browser-playwright";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

const ROOT = new URL("../../", import.meta.url);
const REFERENCE_EXE = new URL("reference/GameOfRobot.exe", ROOT);
/** ROBOT_WINE=1 plays under Wine (as packages/tools/src/driver.ts decides), else natively. */
const NATIVE = process.env["ROBOT_WINE"] !== "1";
const WRAPPER = fileURLToPath(new URL("tools/linux/robot", ROOT));
/** The native game's folder: persistent, so its saves and screenshots stay between plays. */
const NATIVE_PLAY_DIR = new URL(".native/play/", ROOT);
const HARNESS = new URL("tools/wine/harness.py", ROOT);
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
 * In development, POST /play?episode=N with an exe runs it in the game on this display:
 * natively with the wrapper (one game at a time: it ends the earlier one), or with
 * ROBOT_WINE=1 under Wine (tools/wine/harness.py play): the editor's "Test in game". Only the
 * editor's own page may: any other site open in the browser could post an exe here too.
 */
function playGame(): Plugin {
  /** The game this server started natively. */
  let current: ChildProcess | undefined;
  /** Plays one after the other: each ends its predecessor's game and takes its folder. */
  let queue: Promise<unknown> = Promise.resolve();

  const stopCurrent = async () => {
    const old = current;
    current = undefined;
    if (!old) return;
    if (old.exitCode !== null || old.signalCode !== null) return;
    const gone = new Promise<void>((resolve) => {
      old.once("exit", () => {
        resolve();
      });
    });
    old.kill("SIGTERM");
    const timer = setTimeout(() => old.kill("SIGKILL"), 2000);
    await gone;
    clearTimeout(timer);
  };

  /** Starts the wrapper with `bytes`: resolves with an error text, or undefined once it runs. */
  const playNative = async (
    bytes: Buffer,
    logError: (text: string) => void,
  ): Promise<string | undefined> => {
    if (!existsSync(WRAPPER)) return "the wrapper is not built: run pnpm wrapper";
    if (!process.env["DISPLAY"]) return "no DISPLAY to show the game on";
    await stopCurrent();
    mkdirSync(NATIVE_PLAY_DIR, { recursive: true });
    const exe = fileURLToPath(new URL("GameOfRobot.exe", NATIVE_PLAY_DIR));
    const logPath = fileURLToPath(new URL("wrapper.log", NATIVE_PLAY_DIR));
    writeFileSync(exe, bytes);
    // the wrapper's messages go to a file: it needs no reader, however long the game runs
    const log = openSync(logPath, "w");
    const game = spawn(WRAPPER, [exe], { detached: true, stdio: ["ignore", log, log] });
    closeSync(log);
    current = game;
    game.unref();
    const tail = () => readFileSync(logPath, "utf8").trim().split("\n").slice(-5).join("\n");
    return new Promise((resolve) => {
      let settled = false;
      const started = setTimeout(() => {
        settled = true;
        resolve(undefined);
      }, PLAY_REFUSAL_MS);
      game.on("error", (error) => {
        clearTimeout(started);
        resolve(error.message);
      });
      game.on("exit", (code, signal) => {
        if (current === game) current = undefined;
        if (code === 0 || signal !== null) return;
        const text = tail() || `the wrapper ended with code ${String(code)}`;
        clearTimeout(started);
        if (settled)
          logError(text); // a crash later: only the server's log
        else resolve(text);
      });
    });
  };

  return {
    name: "play-game",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/play", (req, res) => {
        const param = new URL(req.url ?? "", "http://localhost").searchParams.get("episode");
        const episode = Number(param);
        const fail = (status: number, text: string) => {
          res.statusCode = status;
          res.end(text);
        };
        if (req.method !== "POST" || !/^[0-4]$/.test(param ?? "")) {
          fail(400, "POST an exe to /play?episode=0..4");
          return;
        }
        const origin = req.headers.origin;
        if (origin === undefined || URL.parse(origin)?.host !== req.headers.host) {
          fail(403, "only the editor's page may run the game");
          return;
        }
        if (!NATIVE && !existsSync(new URL(".wine/prefix/", ROOT))) {
          fail(503, "no Wine prefix: run python3 tools/wine/harness.py setup");
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_EXE_BYTES) chunks.push(chunk); // the rest is read and dropped
        });
        req.on("end", () => {
          const bytes = Buffer.concat(chunks);
          if (size > MAX_EXE_BYTES) {
            fail(413, "not the game's exe: too large");
            return;
          }
          if (bytes.subarray(0, 2).toString("latin1") !== "MZ") {
            fail(400, "not the game's exe: no MZ header");
            return;
          }
          if (NATIVE) {
            const logError = (text: string) => {
              server.config.logger.error(`play: ${text}`);
            };
            queue = queue
              .then(() => playNative(bytes, logError))
              .then((error) => {
                if (error === undefined) {
                  res.statusCode = 202;
                  res.end();
                } else {
                  logError(error);
                  fail(500, error);
                }
              });
            return;
          }
          // a file per request: the harness copies it into the game's folder, while an
          // earlier one may still be copying its own
          const exe = fileURLToPath(new URL(`.wine/play-${randomUUID()}.exe`, ROOT));
          writeFileSync(exe, bytes);
          const args = ["-I", fileURLToPath(HARNESS), "play", String(episode)];
          const game = spawn("python3", [...args, "--exe", exe], {
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
            rmSync(exe, { force: true });
            failed(error.message);
          });
          game.on("exit", (code) => {
            rmSync(exe, { force: true });
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
  plugins: [referenceExe(), playGame()],
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
