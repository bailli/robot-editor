import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, test } from "vitest";

import {
  Game,
  LOGIC_CELL,
  type Mod,
  NO_CHANGES,
  ROOM_CELLS,
  ROOM_WIDTH,
  type Room,
  STAIRS_CLASS,
  applyMod,
  emptyMod,
  readEpisodeStart,
  roomCircuit,
  withExitMode,
} from "@robot/formats";

import { Driver, type HeroState, type Key } from "../src/driver.ts";
import { ROOT, loadGame } from "../src/game.ts";
import { calmRoom } from "../src/patch.ts";
import { readIndexedPng } from "../src/png.ts";

/**
 * Runs the real game under Wine through the proxy DLL (see driver.ts). Opt-in, as it
 * starts Wine for every test: `pnpm proxy` once, then `pnpm test:game`.
 */
const enabled = process.env["ROBOT_GAME_TESTS"] === "1";
const built = existsSync(new URL("tools/wine/proxy/ddraw.dll", ROOT));
const HINT = "`pnpm proxy`, then `pnpm test:game` (needs Wine, Xvfb, harness.py setup)";

async function withGame<T>(exe: string | undefined, use: (d: Driver) => Promise<T>): Promise<T> {
  const d = await Driver.start(exe ? { exe } : {});
  try {
    return await use(d);
  } finally {
    await d.close();
  }
}

/** The game's own screenshots in the Wine prefix (Documents/Robot/…), by modification time. */
function gameScreenshots(): Map<string, number> {
  const users = fileURLToPath(new URL(".wine/prefix/drive_c/users", ROOT));
  const found = new Map<string, number>();
  for (const user of existsSync(users) ? readdirSync(users) : []) {
    const dir = join(users, user, "Documents", "Robot");
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      const path = join(dir, file);
      if (file.endsWith(".png")) found.set(path, statSync(path).mtimeMs);
    }
  }
  return found;
}

/** Holds `key` until `done` holds for the hero, then lets go. */
async function walk(d: Driver, key: Key, done: (hero: HeroState) => boolean): Promise<HeroState> {
  await d.key(key, true);
  await d.until(async () => {
    const hero = await d.hero();
    return hero !== undefined && done(hero);
  }, 3000);
  await d.key(key, false);
  await d.run(20);
  const hero = await d.hero();
  assert.ok(hero);
  return hero;
}

/** The game's map in memory: a word per cell, class | state << 8. */
const MAP = 0x5197f8 + 0xc;

/**
 * Episode III with episode I's circuit pieces (LETTER, GATE, BULB at III's free types
 * 0x40, 0x59, 0x43) and three circuits in room 41, west of a spare piece the hero takes:
 * AND, XOR then NOT, NAND, each of 1 and 1, the node's stairs east of it; the hero
 * starts west of the piece. Made as a mod; returns the exe and the stairs rows (the
 * nodes' rows) that the circuit lights.
 */
function circuitsInEpisodeIII(game: Game): { exe: Uint8Array; lit: number[] } {
  const [LETTER, GATE] = [0x40, 0x59];
  const tileTypes = {
    episode: 3,
    from: 1,
    types: [
      [LETTER, 0x25],
      [0x43, 0x43],
      [GATE, 0x42],
    ] as const,
  };
  // the room is made with the classes the mod gives episode III
  const patched = new Game(game.withTileTypes(3, 1, new Map(tileTypes.types)));
  const ep = patched.episode(3);
  const room = calmRoom(patched.room(3, 41), ep.classes);
  const base = room.base.slice();
  const overlay = room.overlay.slice();
  const at = (x: number, y: number) => x + y * ROOM_WIDTH;
  for (let y = 11; y <= 24; y++) {
    for (let x = 1; x <= 14; x++) base[at(x, y)] = overlay[at(x, y)] = 0;
  }
  const one = LETTER | (0x31 << 8);
  const piece = (state: number) => GATE | (state << 8);
  const records = room.records.slice();
  const used = new Set(records.map((r) => r.slot));
  /** A gate west of a node at row y: A and B from 1s, the pieces from x = 9 on. */
  const circuit = (y: number, pieces: number[]) => {
    base[at(7, y - 1)] = base[at(7, y + 1)] = one;
    base[at(8, y - 1)] = piece(0x0c);
    base[at(8, y + 1)] = piece(0x0d);
    base[at(8, y)] = piece(0x0e);
    pieces.forEach((state, k) => (base[at(9 + k, y)] = piece(state)));
    let slot = 0;
    while (used.has(slot)) slot++;
    used.add(slot);
    const data = new Uint8Array(10);
    data.set([11, 0, 0, 0, 12, y]); // stairs down at (12, y)
    records.push({ slot, data });
    base[at(9 + pieces.length, y)] = LOGIC_CELL | (slot << 8);
  };
  const [AND, NAND, XOR, NOT, ACROSS] = [1, 3, 4, 9, 0x0a];
  circuit(14, [AND]);
  circuit(18, [XOR, NOT]);
  circuit(22, [NAND]);
  base[at(4, 16)] = piece(ACROSS);
  const edited: Room = { ...room, base, overlay, records };
  const lit = roomCircuit(edited, ep.classes).nodes.flatMap((n) =>
    n.signal === 1 ? [Math.floor(n.cell / ROOM_WIDTH)] : [],
  );
  const mod: Mod = {
    ...emptyMod(game.image.data, "circuits in episode III"),
    changes: {
      ...NO_CHANGES,
      tileTypes: [tileTypes],
      rooms: [{ episode: 3, id: 41, room: edited }],
      start: [{ episode: 3, room: 41, x: 2, y: 16 }],
    },
  };
  return { exe: applyMod(game.image, mod), lit };
}

describe.skipIf(!enabled || !built)(`the game through the proxy (${HINT})`, () => {
  const game = loadGame();

  for (const episode of [0, 1, 2, 3, 4]) {
    test(`episode ${String(episode)} starts in the room and cell of its start method`, async () => {
      const hero = await withGame(undefined, (d) => d.startEpisode(episode));
      assert.deepEqual(hero, readEpisodeStart(game.image, episode));
    }, 60_000);
  }

  test("runs repeat exactly: the same steps reach the same game tick", async () => {
    const ticks = [];
    for (let run = 0; run < 2; run++) {
      ticks.push(
        await withGame(undefined, async (d) => {
          await d.startEpisode(1);
          await d.hold("right", 100);
          return { status: await d.status(), hero: await d.hero() };
        }),
      );
    }
    assert.deepEqual(ticks[1], ticks[0]);
  }, 60_000);

  test("a frame is what the game's own screenshot (Ctrl+Alt+P) saves", async () => {
    await withGame(undefined, async (d) => {
      await d.startEpisode(1);
      await d.hold("right", 30);
      await d.run(20);
      const frame = await d.frame();
      const before = gameScreenshots();
      await d.key("control", true);
      await d.key("alt", true);
      await d.hold("P".charCodeAt(0), 5);
      await d.key("alt", false);
      await d.key("control", false);
      await d.run(50);
      const saved = [...gameScreenshots()].filter(([file, time]) => before.get(file) !== time);
      assert.equal(saved.length, 1, "the game saved one screenshot");
      const [file] = saved[0] ?? [""];
      const shot = readIndexedPng(file);
      assert.deepEqual([shot.width, shot.height], [frame.width, frame.height]);
      assert.ok(Buffer.from(shot.indices).equals(frame.indices), "same palette indices");
    });
  }, 60_000);

  test("episode I: without robots and with a west neighbour, room 43 leads to 42", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-driver-"));
    try {
      const exe = join(dir, "GameOfRobot.exe");
      const ep = game.episode(1);
      const rooms = ep.rooms.map((r) =>
        r.id === 43 ? withExitMode(calmRoom(r, ep.classes), "west", "neighbour") : r,
      );
      writeFileSync(exe, game.withScene(1, rooms));
      const arrived = await withGame(exe, async (d) => {
        await d.startEpisode(1);
        // around the inner wall west of the start: east, north, west, south to the exit
        await walk(d, "right", (h) => h.x >= 8);
        await walk(d, "up", (h) => h.y <= 8);
        await walk(d, "left", (h) => h.x <= 2);
        await walk(d, "down", (h) => h.y >= 15);
        return walk(d, "left", (h) => h.room !== 43);
      });
      assert.deepEqual(arrived, { room: 42, x: 38, y: 15 });
    } finally {
      rmSync(dir, { recursive: true });
    }
  }, 60_000);

  test("episode III with episode I's circuit pieces: taking one lights the nodes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-driver-"));
    try {
      const exe = join(dir, "GameOfRobot.exe");
      const { exe: data, lit } = circuitsInEpisodeIII(game);
      assert.deepEqual(lit, [14, 18], "AND and NOT XOR give 1, NAND 0");
      writeFileSync(exe, data);
      const stairs = await withGame(exe, async (d) => {
        await d.startEpisode(3);
        const cells = async () => {
          const map = await d.peek(MAP, 2 * ROOM_CELLS);
          const view = new DataView(map.buffer, map.byteOffset);
          return [14, 18, 22].filter(
            (y) => view.getUint16(2 * (12 + y * ROOM_WIDTH), true) === STAIRS_CLASS,
          );
        };
        assert.deepEqual(await cells(), [], "no stairs before");
        await walk(d, "right", (h) => h.x >= 4); // takes the spare piece
        return cells();
      });
      assert.deepEqual(stairs, lit);
    } finally {
      rmSync(dir, { recursive: true });
    }
  }, 60_000);
});
