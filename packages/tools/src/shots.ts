import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  type Game,
  ROOM_HEIGHT,
  ROOM_WIDTH,
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  TILE_HEIGHT,
  TILE_WIDTH,
  renderRoom,
} from "@robot/formats";

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
  return shot.patched ? calmRoom(room) : room;
}

function describe(game: Game, episode: number, room: number, file: string, patched: boolean): Shot {
  const indices = readShot(file);
  const ep = game.episode(episode);
  const cells = differingCells(
    indices,
    renderRoom(shotRoom(game, { episode, room, patched }), ep.objects, ep.classes),
  );
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

/**
 * Takes a screenshot with the Wine harness: of the episode's start room (room
 * undefined; the room is then the best-matching render) or of any room via a patched
 * exe. Needs Wine, Xvfb and xdotool (see tools/wine/harness.py).
 */
export function takeShot(game: Game, episode: number, room?: number): Shot {
  const stem = room === undefined ? `ep${episode}` : `ep${episode}-room${room}`;
  const file = `shots/${stem}.png`;
  mkdirSync(new URL("shots/", ROOT), { recursive: true });
  mkdirSync(new URL(".wine/", ROOT), { recursive: true });
  const exe = new URL(room === undefined ? "reference/GameOfRobot.exe" : `.wine/${stem}.exe`, ROOT);
  if (room !== undefined) writeFileSync(exe, patchedExe(game, episode, room));
  const result = spawnSync(
    "python3",
    [
      "-I",
      HARNESS,
      "shot",
      String(episode),
      fileURLToPath(new URL(file, ROOT)),
      "--exe",
      fileURLToPath(exe),
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error(`harness failed for ${stem}`);
  if (room !== undefined) return describe(game, episode, room, file, true);
  const indices = readShot(file);
  const ep = game.episode(episode);
  const best = ep.rooms
    .map((r) => ({
      id: r.id,
      n: differingCells(indices, renderRoom(r, ep.objects, ep.classes)).length,
    }))
    .reduce((a, b) => (b.n < a.n ? b : a));
  return describe(game, episode, best.id, file, false);
}
