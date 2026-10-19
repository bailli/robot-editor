#!/usr/bin/env node
/**
 * Command line tools for The Game of Robot.
 *
 *   robot render EPISODE ROOM OUT.png [--zoom N]     render a room (palette PNG)
 *   robot compare EPISODE ROOM SHOT.png [--diff OUT.png]
 *                                                    compare a game screenshot with our render
 *   robot eval [--types]                             differing cells of all screenshots in shots.json
 *   robot patch EPISODE ROOM OUT.exe                 exe that starts in (a copy of) ROOM
 *   robot shots [EPISODE ...]                        screenshot the start rooms (Wine harness)
 *   robot shots --room EPISODE ROOM ...              screenshot any rooms via patched exes
 *   robot shots --update                             recompute shots.json from the screenshots
 *
 * Options: --exe PATH (default reference/GameOfRobot.exe).
 */
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { renderRoom } from "@robot/formats";

import { ROOT, loadGame } from "./game.ts";
import { patchedExe } from "./patch.ts";
import { writeIndexedPng } from "./png.ts";
import {
  type Shot,
  differingCells,
  readManifest,
  readShot,
  shotRoom,
  takeShot,
  updateShot,
  writeManifest,
} from "./shots.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    exe: { type: "string" },
    zoom: { type: "string", default: "1" },
    diff: { type: "string" },
    types: { type: "boolean", default: false },
    room: { type: "boolean", default: false },
    update: { type: "boolean", default: false },
  },
});
const [command, ...args] = positionals;
const game = () => loadGame(values.exe);

function usage(): never {
  console.error("usage: robot render|compare|eval|patch|shots ... (see src/robot.ts)");
  process.exit(2);
}

/** Positional argument i as an integer, or usage(). */
function int(i: number): number {
  const v = Number(args.at(i));
  return Number.isInteger(v) ? v : usage();
}

/** Positional argument i as a string, or usage(). */
function str(i: number): string {
  return args.at(i) ?? usage();
}

function render(episode: number, room: number) {
  const g = game();
  const ep = g.episode(episode);
  return { g, ep, indices: renderRoom(g.room(episode, room), ep.objects, ep.classes) };
}

switch (command) {
  case "render": {
    const [episode, room, out] = [int(0), int(1), str(2)];
    const { ep, indices } = render(episode, room);
    writeIndexedPng(
      out,
      { width: 640, height: 348, indices, palette: ep.palette },
      Number(values.zoom),
    );
    break;
  }
  case "compare": {
    const [episode, room, shot] = [int(0), int(1), str(2)];
    const { g, ep, indices } = render(episode, room);
    const gameIndices = readShot(shot);
    const cells = differingCells(gameIndices, indices);
    const map = g.room(episode, room);
    console.log(`${cells.length} cells differ (row 0 skipped)`);
    for (const [x, y] of cells) {
      const i = y * 40 + x;
      const hex = (v: number | undefined) => `0x${(v ?? 0).toString(16).padStart(4, "0")}`;
      console.log(`  (${x},${y}) base ${hex(map.base[i])} overlay ${hex(map.overlay[i])}`);
    }
    if (values.diff) {
      // game | ours | differing pixels (palette index 0xff, shown magenta)
      const width = 640 * 3;
      const out = new Uint8Array(width * 348);
      for (let y = 0; y < 348; y++) {
        for (let x = 0; x < 640; x++) {
          const a = (gameIndices[y * 640 + x] ?? 0) & 0x0f;
          const b = indices[y * 640 + x] ?? 0;
          out[y * width + x] = a;
          out[y * width + 640 + x] = b;
          out[y * width + 1280 + x] = a === (b & 0x0f) ? 0 : 16;
        }
      }
      const palette = [...ep.palette, [255, 0, 255] as const];
      writeIndexedPng(values.diff, { width, height: 348, indices: out, palette }, 2);
    }
    break;
  }
  case "eval": {
    const g = game();
    let total = 0;
    const byType = new Map<string, number>();
    for (const shot of readManifest()) {
      if (!existsSync(new URL(shot.file, ROOT))) continue;
      const now = updateShot(g, shot);
      total += now.differingCells.length;
      const room = shotRoom(g, shot); // what was compared (patched: without actors)
      for (const [x, y] of now.differingCells) {
        const key = `ep ${shot.episode} base ${(room.base[y * 40 + x] ?? 0) & 0xff} over ${(room.overlay[y * 40 + x] ?? 0) & 0xff}`;
        byType.set(key, (byType.get(key) ?? 0) + 1);
      }
      console.log(
        `ep ${shot.episode} room ${shot.room}${shot.patched ? " p" : "  "}: ${now.differingCells.length}`,
      );
    }
    console.log(`total: ${total}`);
    if (values.types) {
      for (const [key, n] of [...byType].sort((a, b) => b[1] - a[1]).slice(0, 30))
        console.log(`  ${key}: ${n}`);
    }
    break;
  }
  case "patch": {
    const [episode, room, out] = [int(0), int(1), str(2)];
    writeFileSync(out, patchedExe(game(), episode, room));
    break;
  }
  case "shots": {
    const g = game();
    let manifest: Shot[] = existsSync(new URL("shots.json", ROOT)) ? readManifest() : [];
    const add = (shot: Shot) => {
      manifest = [...manifest.filter((s) => s.file !== shot.file), shot];
      writeManifest(manifest);
      console.log(
        `${shot.file}: episode ${shot.episode} room ${shot.room}, ${shot.differingCells.length} differing cells`,
      );
    };
    if (values.update) {
      manifest = manifest.map((s) => updateShot(g, s));
      writeManifest(manifest);
    } else if (values.room) {
      if (args.length < 2) usage();
      const episode = int(0);
      for (let i = 1; i < args.length; i++) add(takeShot(g, episode, int(i)));
    } else {
      const episodes = args.length > 0 ? args.map((_, i) => int(i)) : [0, 1, 2, 3, 4];
      for (const episode of episodes) add(takeShot(g, episode));
    }
    break;
  }
  default:
    usage();
}
