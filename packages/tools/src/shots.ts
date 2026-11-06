import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type Game,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  TILE_HEIGHT,
  TILE_WIDTH,
  backdropRoom,
  renderRoom,
} from "@robot/formats";

import { Driver, type Key, NATIVE } from "./driver.ts";
import { ROOT } from "./game.ts";
import { calmRoom, patchedExe } from "./patch.ts";
import { readIndexedPng } from "./png.ts";

/**
 * Reference screenshots from the real game (shots/, not committed) and their manifest
 * shots.json (committed): per screenshot its hash and the cells where our render
 * currently differs from the game. Pixels are compared by their low 4 bits: dark rooms
 * show the same 16 colours shifted into another part of the game's 224-entry palette,
 * recorded as paletteOffset. Row 0 (the status line) is not compared.
 */
export interface Shot {
  episode: number;
  room: number;
  /** The screenshot PNG, relative to the repository root. */
  file: string;
  /** sha256 of the palette indices. */
  sha256: string;
  paletteOffset: number;
  differingCells: [x: number, y: number][];
  /** Taken with a patched exe (see patch.ts). */
  patched?: true;
}

export const MANIFEST = new URL("shots.json", ROOT);
const HARNESS = fileURLToPath(new URL("tools/wine/harness.py", ROOT));

export function readManifest(): Shot[] {
  return JSON.parse(readFileSync(MANIFEST, "utf8")) as Shot[];
}

export function writeManifest(shots: readonly Shot[]): void {
  const sorted = [...shots].sort(
    (a, b) => a.episode - b.episode || Number(!!a.patched) - Number(!!b.patched) || a.room - b.room,
  );
  writeFileSync(MANIFEST, `[\n${sorted.map((s) => `  ${JSON.stringify(s)}`).join(",\n")}\n]\n`);
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Cells (x, y), row 0 excluded, whose pixels differ in their low 4 bits. */
export function differingCells(game: Uint8Array, ours: Uint8Array): [number, number][] {
  const cells: [number, number][] = [];
  for (let cy = 1; cy < ROOM_HEIGHT; cy++) {
    for (let cx = 0; cx < ROOM_WIDTH; cx++) {
      let differs = false;
      for (let y = 0; y < TILE_HEIGHT && !differs; y++) {
        const row = (cy * TILE_HEIGHT + y) * SCREEN_WIDTH + cx * TILE_WIDTH;
        for (let x = 0; x < TILE_WIDTH && !differs; x++) {
          differs = (((game[row + x] ?? 0) ^ (ours[row + x] ?? 0)) & 0x0f) !== 0;
        }
      }
      if (differs) cells.push([cx, cy]);
    }
  }
  return cells;
}

/** The most common 16-colour group of the playfield (rows below the status line). */
export function paletteOffset(indices: Uint8Array): number {
  const counts = new Map<number, number>();
  for (const b of indices.subarray(SCREEN_WIDTH * TILE_HEIGHT)) {
    counts.set(b & 0xf0, (counts.get(b & 0xf0) ?? 0) + 1);
  }
  return [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best), [0, -1])[0];
}

export function readShot(file: string): Uint8Array {
  const image = readIndexedPng(new URL(file, ROOT));
  if (image.width !== SCREEN_WIDTH || image.height !== SCREEN_HEIGHT) {
    throw new Error(`${file}: expected ${SCREEN_WIDTH}x${SCREEN_HEIGHT}`);
  }
  return image.indices;
}

/** The room a screenshot shows: patched exes hold the room without enemies. */
export function shotRoom(
  game: Game,
  shot: { episode: number; room: number; patched?: boolean | undefined },
) {
  const room = game.room(shot.episode, shot.room);
  return shot.patched ? calmRoom(room, game.episode(shot.episode).classes) : room;
}

/** Our render of a shot's room, with its backdrop (calmed as well in a patched exe). */
export function renderShot(
  game: Game,
  shot: { episode: number; room: number; patched?: boolean | undefined },
): Uint8Array {
  const ep = game.episode(shot.episode);
  const room = shotRoom(game, shot);
  const backdrop = backdropRoom(room, ep.rooms, ep.classes);
  return renderRoom(
    room,
    ep.objects,
    ep.classes,
    backdrop && shot.patched ? calmRoom(backdrop, ep.classes) : backdrop,
  );
}

function describe(game: Game, episode: number, room: number, file: string, patched: boolean): Shot {
  return describeIndices(game, episode, room, file, patched, readShot(file));
}

function describeIndices(
  game: Game,
  episode: number,
  room: number,
  file: string,
  patched: boolean,
  indices: Uint8Array,
): Shot {
  const cells = differingCells(indices, renderShot(game, { episode, room, patched }));
  return {
    episode,
    room,
    file,
    sha256: sha256(indices),
    paletteOffset: paletteOffset(indices),
    differingCells: cells,
    ...(patched ? { patched: true as const } : {}),
  };
}

/** Recomputes a manifest entry from its screenshot (e.g. after renderer changes). */
export function updateShot(game: Game, shot: Shot): Shot {
  return describe(game, shot.episode, shot.room, shot.file, !!shot.patched);
}

/** Virtual milliseconds per step of the screenshot driver (the Driver's default). */
const STEP_MS = 7;

/** What `--keys` and `--wait` of the harness mean: see harness.py `shot`. */
export interface ShotOptions {
  /** Seconds to wait in the room before the keys and the screenshot (default 1). */
  wait?: number;
  /** KEY, KEY:SECONDS (held that long, default 0.3) or wait:SECONDS (default 1). */
  keys?: string[];
  /** Where the PNG goes (default shots/ of the repository). */
  outDir?: URL;
}

const KEY_NAMES: Partial<Record<string, Key>> = {
  return: "return",
  enter: "return",
  shift: "shift",
  control: "control",
  ctrl: "control",
  alt: "alt",
  escape: "escape",
  space: "space",
  left: "left",
  up: "up",
  right: "right",
  down: "down",
};

/** xdotool-style key names (as given to the harness) as the driver's keys. */
function driverKey(name: string): Key | number {
  const key = KEY_NAMES[name.toLowerCase()];
  if (key) return key;
  if (/^[a-z0-9]$/i.test(name)) return name.toUpperCase().charCodeAt(0);
  throw new Error(`unknown key "${name}"`);
}

const steps = (seconds: number) => Math.round((seconds * 1000) / STEP_MS);

/**
 * Gets a driven game into the room like the harness: starts the episode (the title menu,
 * the player-name dialog and the room banner closed), waits, presses the keys.
 */
async function enterRoom(d: Driver, episode: number, options: ShotOptions): Promise<void> {
  await d.startEpisode(episode);
  await d.run(steps(options.wait ?? 1));
  for (const key of options.keys ?? []) {
    const [name = "", seconds] = key.split(":");
    if (name === "wait") {
      await d.run(steps(seconds ? Number(seconds) : 1));
      continue;
    }
    await d.hold(driverKey(name), steps(seconds ? Number(seconds) : 0.3));
    await d.run(steps(0.5));
  }
}

/**
 * The PNGs below `dir`, as byte paths: their names hold the room's name in the game's code
 * page (not UTF-8).
 */
function pngFiles(dir: Buffer): Buffer[] {
  return readdirSync(dir, { encoding: "buffer", withFileTypes: false }).flatMap((name) => {
    const path = Buffer.concat([dir, Buffer.from("/"), name]);
    if (name.toString("latin1").endsWith(".png")) return [path];
    return statSync(path).isDirectory() ? pngFiles(path) : [];
  });
}

/** Natively: the game on virtual time, its last frame written as the PNG. */
async function nativeShot(exe: string, episode: number, out: URL, options: ShotOptions) {
  const d = await Driver.start({ exe, native: true });
  try {
    await enterRoom(d, episode, options);
    // the game's own screenshot command (Ctrl+Alt+P), like the harness: its PNG, not ours
    await d.key("control", true);
    await d.key("alt", true);
    await d.hold("P".charCodeAt(0), 5);
    await d.key("alt", false);
    await d.key("control", false);
    await d.run(50);
    const saved = pngFiles(Buffer.from(d.gameDir ?? ""));
    const file = saved[0] ?? Buffer.alloc(0);
    if (saved.length !== 1) {
      throw new Error(`the game saved ${String(saved.length)} screenshots, not one`);
    }
    copyFileSync(file, out);
  } finally {
    await d.close();
  }
}

function wineShot(exe: string, episode: number, out: URL, options: ShotOptions) {
  const args = ["-I", HARNESS, "shot", String(episode), fileURLToPath(out), "--exe", exe];
  if (options.wait !== undefined) args.push("--wait", String(options.wait));
  if (options.keys?.length) args.push("--keys", ...options.keys);
  const result = spawnSync("python3", args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`harness failed for ${fileURLToPath(out)}`);
}

/**
 * Takes a screenshot: of the episode's start room (room undefined; the room is then the
 * best-matching render) or of any room via a patched exe. Natively with the Driver (the
 * game on virtual time, its last frame as the PNG, no Wine needed); with ROBOT_WINE=1
 * with the Wine harness (needs Wine, Xvfb and xdotool, see tools/wine/harness.py, and
 * deletes the prefix's saved games and screenshots). The Shot's file is always
 * `shots/NAME.png`, whatever `outDir` is.
 */
export async function takeShot(
  game: Game,
  episode: number,
  room?: number,
  options: ShotOptions = {},
): Promise<Shot> {
  const stem = room === undefined ? `ep${episode}` : `ep${episode}-room${room}`;
  const file = `shots/${stem}.png`;
  const outDir = options.outDir ?? new URL("shots/", ROOT);
  mkdirSync(outDir, { recursive: true });
  const out = new URL(`${stem}.png`, outDir);
  let exe = fileURLToPath(new URL("reference/GameOfRobot.exe", ROOT));
  let temp: string | undefined;
  if (room !== undefined) {
    if (NATIVE) {
      temp = mkdtempSync(join(tmpdir(), "robot-shot-"));
      exe = join(temp, `${stem}.exe`);
    } else {
      mkdirSync(new URL(".wine/", ROOT), { recursive: true });
      exe = fileURLToPath(new URL(`.wine/${stem}.exe`, ROOT));
    }
    writeFileSync(exe, patchedExe(game, episode, room));
  }
  try {
    if (NATIVE) await nativeShot(exe, episode, out, options);
    else wineShot(exe, episode, out, options);
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  const indices = readIndexedPng(out).indices;
  if (room !== undefined) return describeIndices(game, episode, room, file, true, indices);
  const ep = game.episode(episode);
  const best = ep.rooms
    .map((r) => ({
      id: r.id,
      n: differingCells(indices, renderShot(game, { episode, room: r.id })).length,
    }))
    .reduce((a, b) => (b.n < a.n ? b : a));
  return describeIndices(game, episode, best.id, file, false, indices);
}
