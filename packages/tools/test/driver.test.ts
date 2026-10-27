import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, test } from "vitest";

import {
  type EventChange,
  Game,
  LOGIC_CELL,
  type Mod,
  type ModChanges,
  NO_CHANGES,
  ROOM_CELLS,
  ROOM_WIDTH,
  STAIRS_CLASS,
  applyMod,
  emptyMod,
  readEpisodeStart,
  roomCircuit,
  textsId,
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

/** Cells of the map in memory whose class is `classId` (state ignored). */
async function cellsOfClass(d: Driver, classId: number, cells: number[]): Promise<number[]> {
  const map = await d.peek(MAP, 2 * ROOM_CELLS);
  const view = new DataView(map.buffer, map.byteOffset);
  return cells.filter((cell) => (view.getUint16(2 * cell, true) & 0xff) === classId);
}

/**
 * A mod for `episode` whose start room (made calm, cells x0..x1, y0..y1 cleared) gets
 * what `fill` puts there, the hero starting at (x, y). `fill` adds records with `record`.
 */
function startRoomMod(
  game: Game,
  episode: number,
  changes: Partial<ModChanges>,
  area: { x0: number; x1: number; y0: number; y1: number },
  hero: { x: number; y: number },
  fill: (set: (x: number, y: number, cell: number) => void, record: RecordAdder) => void,
): Mod {
  const id = readEpisodeStart(game.image, episode).room;
  const room = calmRoom(game.room(episode, id), game.episode(episode).classes);
  const base = room.base.slice();
  const overlay = room.overlay.slice();
  for (let y = area.y0; y <= area.y1; y++) {
    for (let x = area.x0; x <= area.x1; x++)
      base[x + y * ROOM_WIDTH] = overlay[x + y * ROOM_WIDTH] = 0;
  }
  const records = room.records.slice();
  const used = new Set(records.map((r) => r.slot));
  const set = (x: number, y: number, cell: number) => {
    base[x + y * ROOM_WIDTH] = cell;
  };
  fill(set, (x, y, data) => {
    let slot = 0;
    while (used.has(slot)) slot++;
    used.add(slot);
    records.push({ slot, data: Uint8Array.from({ length: 10 }, (_, k) => data[k] ?? 0) });
    set(x, y, LOGIC_CELL | (slot << 8));
  });
  return {
    ...emptyMod(game.image.data),
    changes: {
      ...NO_CHANGES,
      ...changes,
      rooms: [{ episode, id, room: { ...room, base, overlay, records } }],
      start: [{ episode, room: id, ...hero }],
    },
  };
}

type RecordAdder = (x: number, y: number, data: number[]) => void;

/**
 * Episode I's circuit pieces (LETTER, GATE, BULB, and STAIRS where the episode has
 * none) at free tile types of `episode`, and three circuits in its start room, west of
 * a spare piece the hero takes: AND, XOR then NOT, NAND, each of 1 and 1, the node's
 * stairs east of it at x = 12; the hero starts at (2, 16). Returns the mod and the rows
 * whose nodes the circuit lights.
 */
function circuitsMod(
  game: Game,
  episode: number,
  types: { letter: number; gate: number; bulb: number; stairs?: number },
): { mod: Mod; lit: number[] } {
  const pairs: [number, number][] = [
    [types.letter, 0x25],
    [types.gate, 0x42],
    [types.bulb, 0x43],
  ];
  if (types.stairs !== undefined) pairs.push([types.stairs, 0x3d]);
  const tileTypes = [{ episode, from: 1, types: pairs }];
  const one = types.letter | (0x31 << 8);
  const piece = (state: number) => types.gate | (state << 8);
  const [AND, NAND, XOR, NOT, ACROSS] = [1, 3, 4, 9, 0x0a];
  const mod = startRoomMod(
    game,
    episode,
    { tileTypes },
    { x0: 1, x1: 14, y0: 11, y1: 24 },
    { x: 2, y: 16 },
    (set, record) => {
      /** A gate west of a node at row y: A and B from 1s, the pieces from x = 9 on. */
      const circuit = (y: number, pieces: number[]) => {
        set(7, y - 1, one);
        set(7, y + 1, one);
        set(8, y - 1, piece(0x0c));
        set(8, y + 1, piece(0x0d));
        set(8, y, piece(0x0e));
        pieces.forEach((state, k) => {
          set(9 + k, y, piece(state));
        });
        record(9 + pieces.length, y, [11, 0, 0, 0, 12, y]); // stairs down at (12, y)
      };
      circuit(14, [AND]);
      circuit(18, [XOR, NOT]);
      circuit(22, [NAND]);
      set(4, 16, piece(ACROSS));
    },
  );
  // the circuit as the editor sees it, with the classes the mod gives the episode
  const classes = new Game(applyMod(game.image, mod)).episode(episode).classes;
  const room = mod.changes.rooms[0]?.room;
  assert.ok(room);
  const lit = roomCircuit(room, classes).nodes.flatMap((n) =>
    n.signal === 1 ? [Math.floor(n.cell / ROOM_WIDTH)] : [],
  );
  return { mod, lit };
}

/**
 * Episode II's tangram and oracle at free tile types of `episode`, its hint and death
 * texts (copyTexts), and two oracles with their symbols found in the start room: north
 * of the hero's start (4, 16) one that sends him to (10, 16), at (12, 16) one that shows
 * hint 331 when walked into eastwards. `events` and `eventTexts` ([to, of] from II's
 * texts) add what the episode's event table lacks.
 */
function oraclesMod(
  game: Game,
  episode: number,
  [tangram, oracle]: readonly [number, number],
  events: readonly EventChange[] = [],
  eventTexts: readonly (readonly [number, number])[] = [],
): Mod {
  const room = readEpisodeStart(game.image, episode).room;
  const target = room | (10 << 10);
  const copyTexts =
    episode === 2 || episode === 3
      ? []
      : [
          {
            resource: textsId(episode),
            from: textsId(2),
            entries: [...[331, 334, 945].map((n) => [n, n] as const), ...eventTexts],
          },
        ];
  const tileTypes = [
    {
      episode,
      from: 2,
      types: [
        [tangram, 0x50],
        [oracle, 0x51],
      ] as const,
    },
  ];
  return startRoomMod(
    game,
    episode,
    { tileTypes, copyTexts, events },
    { x0: 2, x1: 12, y0: 12, y1: 18 },
    { x: 4, y: 16 },
    (_, record) => {
      // state 0x10 | n: symbol n found; target room | x << 10, y
      const oracleRecord = (n: number) => [12, 0, oracle, 0x10 | n, target & 0xff, target >> 8, 16];
      record(4, 15, oracleRecord(4));
      record(12, 16, oracleRecord(1));
    },
  );
}

/** Writes the mod's exe to a temporary directory for `use`. */
async function withModExe<T>(game: Game, mod: Mod, use: (exe: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "robot-driver-"));
  try {
    const exe = join(dir, "GameOfRobot.exe");
    writeFileSync(exe, applyMod(game.image, mod));
    return await use(exe);
  } finally {
    rmSync(dir, { recursive: true });
  }
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

  const CIRCUITS = [
    { episode: 3, types: { letter: 0x40, gate: 0x59, bulb: 0x43 } },
    { episode: 4, types: { letter: 0x6d, gate: 0x6e, bulb: 0x6f } },
    // Junior has no stairs: they come along from episode I
    { episode: 0, types: { letter: 0x40, gate: 0x42, bulb: 0x43, stairs: 0x3d } },
  ];
  for (const { episode, types } of CIRCUITS) {
    test(`episode ${String(episode)} with episode I's circuit pieces: taking one lights the nodes`, async () => {
      const { mod, lit } = circuitsMod(game, episode, types);
      assert.deepEqual(lit, [14, 18], "AND and NOT XOR give 1, NAND 0");
      const stairsCells = [14, 18, 22].map((y) => 12 + y * ROOM_WIDTH);
      const stairs = await withModExe(game, mod, (exe) =>
        withGame(exe, async (d) => {
          await d.startEpisode(episode);
          assert.deepEqual(await cellsOfClass(d, STAIRS_CLASS, stairsCells), [], "none before");
          await walk(d, "right", (h) => h.x >= 4); // takes the spare piece
          return cellsOfClass(d, STAIRS_CLASS, stairsCells);
        }),
      );
      assert.deepEqual(
        stairs,
        lit.map((y) => 12 + y * ROOM_WIDTH),
      );
    }, 60_000);
  }

  const ORACLES = [
    { episode: 0, types: [0x50, 0x51] },
    { episode: 1, types: [0x50, 0x51] },
    // IV's table has no oracle events: its unused entries 197 and 198 become those of
    // the two oracles (262 + symbol), with II's texts for them
    {
      episode: 4,
      types: [0x70, 0x71],
      events: [
        { episode: 4, entry: 197, id: 263, points: 3500 },
        { episode: 4, entry: 198, id: 266, points: 3500 },
      ],
      eventTexts: [
        [1997, 1935],
        [1998, 1938],
      ],
    },
  ] as const;
  for (const { episode, types, ...more } of ORACLES) {
    const points = 3500;
    test(`episode ${String(episode)} with episode II's oracles: north sends, east hints`, async () => {
      const events = "events" in more ? more.events : [];
      const eventTexts = "eventTexts" in more ? more.eventTexts : [];
      const mod = oraclesMod(game, episode, types, events, eventTexts);
      const seen = await withModExe(game, mod, (exe) =>
        withGame(exe, async (d) => {
          const room = (await d.startEpisode(episode)).room;
          await d.hold("up", 40); // into the oracle north of the start
          await d.run(200);
          // the bonus box with the event's text, where the mod brings one: the oracle
          // sends the hero once it is closed
          if (eventTexts.length > 0) await d.press("return", 200);
          const sent = await d.hero();
          const afterNorth = await d.score();
          await walk(d, "right", (h) => h.x >= 11);
          await d.hold("right", 40); // into the oracle at (12, 16): hint 331
          await d.run(60);
          return { room, sent, afterNorth, afterEast: await d.score() };
        }),
      );
      assert.deepEqual(seen.sent, { room: seen.room, x: 10, y: 16 });
      assert.deepEqual([seen.afterNorth, seen.afterEast], [points, 2 * points]);
    }, 60_000);
  }
});
