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
 *   robot script EPISODE ROOM                        a room's script: source and disassembly
 *   robot script EPISODE ROOM SOURCE OUT.exe         exe whose ROOM runs the script in SOURCE
 *   robot start EPISODE ROOM OUT.exe [--at X,Y]      exe whose episode starts in ROOM (the hero at X, Y)
 *   robot play EPISODE ROOM [--at X,Y] [--mute]      play the episode from ROOM in the game (Wine)
 *   robot mod apply MOD OUT.exe                      the exe a mod (JSON, see mod.ts) makes
 *
 * Options: --exe PATH (default reference/GameOfRobot.exe).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ModError,
  applyMod,
  disassemble,
  parseCompiledScript,
  parseMod,
  readEpisodeStart,
  roomCompiledScript,
  roomScript,
  withEpisodeStart,
  withRoomScript,
} from "@robot/formats";

import { ROOT, loadGame } from "./game.ts";
import { patchedExe } from "./patch.ts";
import { writeIndexedPng } from "./png.ts";
import {
  type Shot,
  differingCells,
  readManifest,
  readShot,
  renderShot,
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
    at: { type: "string" },
    mute: { type: "boolean", default: false },
  },
});
const [command, ...args] = positionals;
const game = () => loadGame(values.exe);

function usage(): never {
  console.error(
    "usage: robot render|compare|eval|patch|shots|script|start|play|mod ... (see src/robot.ts)",
  );
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

/** The exe whose episode starts in `room`, the hero at --at X,Y or the episode's start. */
function startExe(episode: number, room: number): Uint8Array {
  const g = game();
  g.room(episode, room);
  const at = values.at?.split(",").map(Number);
  const start = at ? { room, x: at[0], y: at[1] } : { ...readEpisodeStart(g.image, episode), room };
  return withEpisodeStart(g.image, episode, start);
}

function render(episode: number, room: number) {
  const g = game();
  const ep = g.episode(episode);
  return { g, ep, indices: renderShot(g, { episode, room }) };
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
  case "script": {
    const [episode, id] = [int(0), int(1)];
    const g = game();
    if (args.length > 2) {
      const [source, out] = [str(2), str(3)];
      const options = { constants: g.scriptConstants(episode), keywords: g.scriptKeywords() };
      const rooms = g
        .episode(episode)
        .rooms.map((r) =>
          r.id === id ? withRoomScript(r, readFileSync(source, "utf8"), options) : r,
        );
      if (!rooms.some((r) => r.id === id)) usage();
      writeFileSync(out, g.withScene(episode, rooms));
      break;
    }
    const room = g.room(episode, id);
    const compiled = roomCompiledScript(room);
    console.log(roomScript(room) || "(no script)");
    if (compiled) console.log(`\n${disassemble(parseCompiledScript(compiled))}`);
    break;
  }
  case "start": {
    const [episode, room, out] = [int(0), int(1), str(2)];
    writeFileSync(out, startExe(episode, room));
    break;
  }
  case "play": {
    const [episode, room] = [int(0), int(1)];
    const exe = new URL(".wine/play.exe", ROOT);
    mkdirSync(new URL(".wine/", ROOT), { recursive: true });
    writeFileSync(exe, startExe(episode, room));
    const harness = fileURLToPath(new URL("tools/wine/harness.py", ROOT));
    const args = ["-I", harness, "play", String(episode), "--exe", fileURLToPath(exe)];
    const result = spawnSync("python3", values.mute ? [...args, "--mute"] : args, {
      stdio: "inherit",
    });
    process.exitCode = result.status ?? 1;
    break;
  }
  case "mod": {
    if (str(0) !== "apply") usage();
    const [source, out] = [str(1), str(2)];
    try {
      const mod = parseMod(readFileSync(source, "utf8"));
      writeFileSync(out, applyMod(game().image, mod));
      const { tileTypes, code, texts, rooms, start } = mod.changes;
      console.log(
        `${out}: ${tileTypes.length} tile type changes, ${code.length} code, ` +
          `${texts.length} texts, ${rooms.length} rooms, ${start.length} starts`,
      );
    } catch (error) {
      if (!(error instanceof ModError)) throw error;
      console.error(`${source}: ${error.message}`);
      process.exitCode = 1;
    }
    break;
  }
  default:
    usage();
}
