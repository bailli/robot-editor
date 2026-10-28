import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, test } from "vitest";

import {
  type BackdropRule,
  EVENT_TEXT,
  Game,
  KITS,
  type Kit,
  type KitPlan,
  LOGIC_CELL,
  type LogicRecord,
  type Mod,
  type ModChanges,
  NO_CHANGES,
  ORACLE_VANISHES_EAST,
  ORACLE_VANISHES_NORTH,
  ROOM_CELLS,
  ROOM_WIDTH,
  type Room,
  STAIRS_CLASS,
  applyMod,
  backdropRoom,
  emptyMod,
  eventTextsId,
  kitChanges,
  planKit,
  readEpisodeFlags,
  readEpisodeStart,
  readEventTable,
  renderRoom,
  robotSprite,
  robotSpriteCount,
  roomActors,
  roomCircuit,
  withExitMode,
  withRoomScript,
} from "@robot/formats";

import { Driver, type HeroState, type Key } from "../src/driver.ts";
import { ROOT, loadGame } from "../src/game.ts";
import { calmRoom } from "../src/patch.ts";
import { readIndexedPng } from "../src/png.ts";
import { differingCells } from "../src/shots.ts";

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

/** A kit of formats' KITS. */
function kit(key: string): Kit {
  const found = KITS.find((k) => k.key === key);
  assert.ok(found, key);
  return found;
}

/** The type a kit's plan copies `of` to. */
function kitType(plan: KitPlan, of: number): number {
  const to = plan.types.find(([, o]) => o === of)?.[0];
  assert.ok(to !== undefined, `the plan copies no type 0x${of.toString(16)}`);
  return to;
}

/**
 * The circuits kit in `episode` (episode I's LETTER, GATE, BULB, and STAIRS where the
 * episode has none, event 293 where it fits) and three circuits in its start room, west
 * of a spare piece the hero takes: AND, XOR then NOT, NAND, each of 1 and 1, the node's
 * stairs east of it at x = 12; the hero starts at (2, 16). Returns the mod, the rows
 * whose nodes the circuit lights and the gate piece's type.
 */
function circuitsMod(game: Game, episode: number): { mod: Mod; lit: number[]; gate: number } {
  const circuits = kit("circuits");
  const plan = planKit(game, episode, circuits);
  assert.equal(plan.problem, undefined);
  const letter = kitType(plan, 0x25);
  const gate = kitType(plan, 0x42);
  const one = letter | (0x31 << 8);
  const piece = (state: number) => gate | (state << 8);
  const [AND, NAND, XOR, NOT, ACROSS] = [1, 3, 4, 9, 0x0a];
  const mod = startRoomMod(
    game,
    episode,
    kitChanges(game, episode, circuits, plan),
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
  return { mod, lit, gate };
}

/**
 * The oracles kit in `episode` (episode II's tangram and oracle, their hints and death
 * text, the events of the symbols `events` where the episode lacks them, with their
 * texts) and two oracles with their symbols found in the start room: north of the
 * hero's start (4, 16) one that sends him to (10, 16), at (12, 16) one that shows hint
 * 331 when walked into eastwards. Returns the mod and whether the events come with a
 * text (a bonus box).
 */
function oraclesMod(
  game: Game,
  episode: number,
  events?: readonly number[],
): { mod: Mod; box: boolean } {
  const oracles = kit("oracles");
  const plan = planKit(game, episode, oracles, events ? { events } : {});
  assert.equal(plan.problem, undefined);
  const oracle = kitType(plan, 0x51);
  const room = readEpisodeStart(game.image, episode).room;
  const target = room | (10 << 10);
  const changes = kitChanges(game, episode, oracles, plan);
  const box = changes.copyTexts.some((c) =>
    c.entries.some(([to]) => to >= EVENT_TEXT && c.resource === eventTextsId(episode)),
  );
  const mod = startRoomMod(
    game,
    episode,
    changes,
    { x0: 2, x1: 12, y0: 12, y1: 18 },
    { x: 4, y: 16 },
    (_, record) => {
      // state 0x10 | n: symbol n found; target room | x << 10, y
      const oracleRecord = (n: number) => [12, 0, oracle, 0x10 | n, target & 0xff, target >> 8, 16];
      record(4, 15, oracleRecord(4));
      record(12, 16, oracleRecord(1));
    },
  );
  return { mod, box };
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

/**
 * The actors in the room's list (0x53e9a8, linked by +4) in their order: class (+0x16)
 * and, for robots (class 2), the `_Aliens` sprite (+0x28).
 */
async function actorList(d: Driver): Promise<string[]> {
  const list: string[] = [];
  for (let p = await d.u32(0x53e9a8); p !== 0 && list.length < 200;) {
    const bytes = await d.peek(p, 0x2c);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const cls = view.getUint16(0x16, true);
    list.push(cls === 2 ? `2:${String(view.getUint32(0x28, true))}` : String(cls));
    p = view.getUint32(4, true);
  }
  return list;
}

/**
 * Episode II's room 115 (drawn over room 15) as the start room, the hero at (21, 9) in
 * the house, with `edit` applied to its cells; the cells where the game's frame differs
 * from our render, and those where our render differs from the unedited room's.
 */
async function backdropCells(
  game: Game,
  edit: (base: Uint16Array, overlay: Uint16Array) => LogicRecord[],
): Promise<{ game: number[]; edited: number[] }> {
  const ep = game.episode(2);
  const room = calmRoom(game.room(2, 115), ep.classes);
  const base = room.base.slice();
  const overlay = room.overlay.slice();
  // without its script, which lays eggs in the house's corners on the first visit
  const tags = room.tags.filter((t) => t.kind !== 6);
  const records = [...room.records, ...edit(base, overlay)];
  const edited = { ...room, base, overlay, records, tags };
  const render = (r: Room) =>
    renderRoom(r, ep.objects, ep.classes, backdropRoom(r, ep.rooms, ep.classes));
  const cells = (pairs: [number, number][]) => pairs.map(([x, y]) => x + y * ROOM_WIDTH);
  const mod: Mod = {
    ...emptyMod(game.image.data),
    changes: {
      ...NO_CHANGES,
      rooms: [{ episode: 2, id: 115, room: edited }],
      start: [{ episode: 2, room: 115, x: 21, y: 9 }],
    },
  };
  const frame = await withModExe(game, mod, (exe) =>
    withGame(exe, async (d) => {
      await d.startEpisode(2);
      await d.run(20);
      return d.frame();
    }),
  );
  const ours = render(edited);
  return {
    game: cells(differingCells(frame.indices, ours)),
    edited: cells(differingCells(render(room), ours)),
  };
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

  // the circuits kit; a lit node is event 293: 4000 points in Junior (its own entry)
  // and IV (a spare entry the kit gives it), none in III (no entry left)
  const CIRCUITS = [
    { episode: 3, nodePoints: 0 },
    { episode: 4, nodePoints: 4000 },
    // Junior has no stairs: they come along from episode I
    { episode: 0, nodePoints: 4000 },
  ];
  for (const { episode, nodePoints } of CIRCUITS) {
    test(`episode ${String(episode)} with the circuits kit: taking a piece lights the nodes`, async () => {
      const { mod, lit, gate } = circuitsMod(game, episode);
      assert.deepEqual(lit, [14, 18], "AND and NOT XOR give 1, NAND 0");
      // the piece's first take, as the kit copied it from episode I
      const firstTake = readEventTable(new Game(applyMod(game.image, mod)).image, episode)[gate];
      assert.ok(firstTake);
      const stairsCells = [14, 18, 22].map((y) => 12 + y * ROOM_WIDTH);
      const seen = await withModExe(game, mod, (exe) =>
        withGame(exe, async (d) => {
          await d.startEpisode(episode);
          assert.deepEqual(await cellsOfClass(d, STAIRS_CLASS, stairsCells), [], "none before");
          const before = await d.score();
          await walk(d, "right", (h) => h.x >= 4); // takes the spare piece
          await d.run(60);
          return {
            stairs: await cellsOfClass(d, STAIRS_CLASS, stairsCells),
            points: (await d.score()) - before,
          };
        }),
      );
      assert.deepEqual(
        seen.stairs,
        lit.map((y) => 12 + y * ROOM_WIDTH),
      );
      assert.equal(seen.points, firstTake.points + nodePoints);
    }, 60_000);
  }

  // the oracles kit; IV's table has no oracle events: the kit gives two of its spare
  // entries those of the two oracles (262 + symbol), with II's texts for them
  const ORACLES: readonly { episode: number; events?: readonly number[] }[] = [
    { episode: 0 },
    { episode: 1 },
    { episode: 4, events: [263, 266] },
  ];
  for (const { episode, events } of ORACLES) {
    const points = 3500;
    test(`episode ${String(episode)} with the oracles kit: north sends, east hints`, async () => {
      const { mod, box } = oraclesMod(game, episode, events);
      const seen = await withModExe(game, mod, (exe) =>
        withGame(exe, async (d) => {
          const room = (await d.startEpisode(episode)).room;
          await d.hold("up", 40); // into the oracle north of the start
          await d.run(200);
          // the bonus box with the event's text, where the mod brings one: the oracle
          // sends the hero once it is closed
          if (box) await d.press("return", 200);
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

  test("episode III: robots take their sprite by their place among the room's actors", async () => {
    const [ROBOT, TURTLE, BOAR, SNAKE, ITEM] = [0x02, 0x2e, 0x37, 0x2d, 0x08];
    const row = [ROBOT, ROBOT, TURTLE, ROBOT, BOAR, ROBOT, ROBOT, SNAKE, ROBOT, ROBOT, ROBOT];
    const mod = startRoomMod(
      game,
      3,
      {},
      { x0: 2, x1: 36, y0: 0, y1: 6 },
      { x: 8, y: 15 },
      (set, record) => {
        set(20, 0, ROBOT); // row 0 is not loaded
        for (const [i, cell] of row.entries()) {
          set(3 + 3 * i, 3, cell);
          set(4 + 3 * i, 5, cell);
        }
        record(6, 5, [7, 0, 0, 0, 0, 0, 0, 1]); // a native
        for (const x of [30, 32, 34]) set(x, 3, ROBOT);
      },
    );
    const [change] = mod.changes.rooms;
    assert.ok(change);
    const room = change.room;
    assert.ok(room);
    const overlay = room.overlay.slice();
    overlay[30 + 3 * ROOM_WIDTH] = ITEM; // hides the robot under it
    overlay[32 + 3 * ROOM_WIDTH] = ROBOT; // so does a robot in the same state
    overlay[34 + 3 * ROOM_WIDTH] = ROBOT | 0x100; // not one in another state
    const edited = { ...room, overlay, tags: room.tags.filter((t) => t.kind !== 6) };
    const modded = { ...mod, changes: { ...mod.changes, rooms: [{ ...change, room: edited }] } };
    const classes = game.episode(3).classes;
    const count = robotSpriteCount(3, game.aliens(3).length);
    const expected = roomActors(edited, classes)
      .filter((a) => a.order !== undefined)
      .map((a) => {
        if (a.source === "creature") return "159";
        const cls = classes.classes.get(a.type ?? 0)?.id ?? 0;
        return cls === 2 ? `2:${String(robotSprite(a, count))}` : String(cls);
      });
    const seen = await withModExe(game, modded, (exe) =>
      withGame(exe, async (d) => {
        await d.startEpisode(3);
        return actorList(d);
      }),
    );
    assert.equal(expected.length, 2 * row.length + 1 + 2);
    assert.deepEqual(seen, expected);
  }, 60_000);

  for (const episode of [0, 1, 2, 3, 4]) {
    const scorpions = episode !== 4;
    test(`episode ${String(episode)}: a sand heap ${scorpions ? "lets a scorpion out" : "does nothing"}`, async () => {
      const start = readEpisodeStart(game.image, episode);
      const [x, y] = [start.x + 1, start.y];
      const heap = (episode === 0 ? 0x27 : 0x31) | 0x600;
      const area = { x0: x, x1: x, y0: y, y1: y };
      const mod = startRoomMod(game, episode, {}, area, start, (set) => {
        set(x, y, heap);
      });
      const seen = await withModExe(game, mod, (exe) =>
        withGame(exe, async (d) => {
          await d.startEpisode(episode);
          await d.hold("right", 20); // onto the heap
          await d.run(30);
          const map = await d.peek(MAP + 2 * (x + y * ROOM_WIDTH), 2);
          return {
            cell: new DataView(map.buffer, map.byteOffset).getUint16(0, true),
            actors: (await actorList(d)).length,
          };
        }),
      );
      // the class of sand is 0x27 in every episode
      assert.deepEqual(seen, scorpions ? { cell: 0x27, actors: 1 } : { cell: 0x627, actors: 0 });
    }, 60_000);
  }

  const at = (x: number, y: number) => x + y * ROOM_WIDTH;
  const HERO = at(21, 9);

  for (const vanish of [false, true]) {
    test(`Junior's oracles ${vanish ? "vanish with II's flags" : "stay"} after north and east`, async () => {
      const oracles = ORACLE_VANISHES_NORTH | ORACLE_VANISHES_EAST;
      const { mod } = oraclesMod(game, 0);
      const flags = readEpisodeFlags(game.image, 0) | (vanish ? oracles : 0);
      const cells = [at(4, 15), at(12, 16)];
      const seen = await withModExe(
        game,
        { ...mod, changes: { ...mod.changes, flags: [{ episode: 0, flags }] } },
        (exe) =>
          withGame(exe, async (d) => {
            await d.startEpisode(0);
            await d.hold("up", 40); // into the oracle north of the start: sent to (10, 16)
            await d.run(200);
            await walk(d, "right", (h) => h.x >= 11);
            await d.hold("right", 40); // into the oracle at (12, 16): its hint
            await d.run(60);
            await d.press("return", 100); // the hint's box
            // away from it, to see what lies there: the record shows an empty cell (0x4331a0
            // sets the cell a logic cell shows) or still the oracle
            await walk(d, "left", (h) => h.x <= 9);
            const frame = await d.frame();
            const pixels = (cell: number) => {
              const [x, y] = [(cell % ROOM_WIDTH) * 16, Math.floor(cell / ROOM_WIDTH) * 12];
              const row = (r: number) => (y + r) * frame.width + x;
              return Array.from({ length: 12 }, (_, r) =>
                frame.indices.subarray(row(r), row(r) + 16).join(","),
              ).join(";");
            };
            const floor = pixels(at(6, 13));
            const gone = cells.map((cell) => pixels(cell) === floor);
            // the north oracle once more: it sends again, or the hero walks on
            await walk(d, "left", (h) => h.x <= 4);
            await d.hold("up", 40);
            await d.run(200);
            return { gone, again: await d.hero() };
          }),
      );
      assert.deepEqual(seen.gone, [vanish, vanish], "the oracles drawn as empty floor");
      assert.deepEqual(seen.again, vanish ? { room: 43, x: 4, y: 12 } : { room: 43, x: 10, y: 16 });
    }, 60_000);
  }

  for (const own of [false, true]) {
    test(`Junior's robots ${own ? "keep their sprite's colours with flag 0x20" : "roll colours"}`, async () => {
      const start = readEpisodeStart(game.image, 0);
      const area = { x0: 10, x1: 20, y0: 5, y1: 5 };
      const flags = readEpisodeFlags(game.image, 0) | (own ? 0x20 : 0);
      const mod = startRoomMod(game, 0, { flags: [{ episode: 0, flags }] }, area, start, (set) => {
        for (const x of [10, 13, 16, 19]) set(x, 5, 0x02);
      });
      const robots = await withModExe(game, mod, (exe) =>
        withGame(exe, async (d) => {
          await d.startEpisode(0);
          // the actors (0x53e9a8, linked by +4): robots (class 2) with their sprite (+0x28)
          // and colours (+0x30, rolled by the constructor 0x445bd0)
          const found: { sprite: number; colours: number[] }[] = [];
          for (let p = await d.u32(0x53e9a8); p !== 0 && found.length < 50;) {
            const bytes = await d.peek(p, 0x34);
            const view = new DataView(bytes.buffer, bytes.byteOffset);
            if (view.getUint16(0x16, true) === 2) {
              found.push({
                sprite: view.getUint32(0x28, true),
                colours: [...bytes.subarray(0x30, 0x33)],
              });
            }
            p = view.getUint32(4, true);
          }
          return found;
        }),
      );
      assert.equal(robots.length, 4);
      const aliens = game.aliens(0);
      for (const { sprite, colours } of robots) {
        if (own) assert.deepEqual(colours, aliens[sprite]?.colours);
        else {
          assert.equal(new Set(colours).size, 3, "three distinct colours");
          assert.ok(
            colours.every((c) => c >= 8 && c <= 14),
            `${String(colours)} in 8-14`,
          );
        }
      }
    }, 60_000);
  }

  for (const noKey of [false, true]) {
    test(`episode II: a door in ${noKey ? "takes the hero without the key with flag 0x80000" : "wants the key"}`, async () => {
      const ep = game.episode(2);
      const room = calmRoom(game.room(2, 15), ep.classes);
      const flags = readEpisodeFlags(game.image, 2) | (noKey ? 0x80000 : 0);
      const mod: Mod = {
        ...emptyMod(game.image.data),
        changes: {
          ...NO_CHANGES,
          rooms: [{ episode: 2, id: 15, room }],
          // north of the house's door (26, 8), state 7: entered walking south
          start: [{ episode: 2, room: 15, x: 26, y: 7 }],
          flags: [{ episode: 2, flags }],
        },
      };
      const hero = await withModExe(game, mod, (exe) =>
        withGame(exe, async (d) => {
          await d.startEpisode(2);
          await d.hold("down", 40);
          await d.run(100);
          return d.hero();
        }),
      );
      assert.equal(hero?.room, noKey ? 115 : 15);
    }, 60_000);
  }

  for (const cleared of [true, false]) {
    test(`episode I: the Teleport() point is ${cleared ? "cleared on entering a room (flag 0x2000)" : "kept without flag 0x2000"}`, async () => {
      const ep = game.episode(1);
      const options = { constants: game.scriptConstants(1), keywords: game.scriptKeywords() };
      const room43 = withRoomScript(
        withExitMode(calmRoom(game.room(1, 43), ep.classes), "west", "neighbour"),
        "Teleport(44, 5, 6);",
        options,
      );
      const flags = readEpisodeFlags(game.image, 1) & ~(cleared ? 0 : 0x2000);
      const mod: Mod = {
        ...emptyMod(game.image.data),
        changes: {
          ...NO_CHANGES,
          rooms: [{ episode: 1, id: 43, room: room43 }],
          flags: [{ episode: 1, flags: flags >>> 0 }],
        },
      };
      // the point: room (word), x, y at 0x4fe358
      const point = async (d: Driver) => [...(await d.peek(0x4fe358, 4))];
      const seen = await withModExe(game, mod, (exe) =>
        withGame(exe, async (d) => {
          await d.startEpisode(1);
          const set = await point(d);
          // around the inner wall west of the start, as in the test above
          await walk(d, "right", (h) => h.x >= 8);
          await walk(d, "up", (h) => h.y <= 8);
          await walk(d, "left", (h) => h.x <= 2);
          await walk(d, "down", (h) => h.y >= 15);
          const arrived = await walk(d, "left", (h) => h.room !== 43);
          return { set, arrived: arrived.room, after: await point(d) };
        }),
      );
      assert.deepEqual(seen, {
        set: [44, 0, 5, 6],
        arrived: 42,
        // cleared: room 0, teleporters go to their own target again (x and y stay)
        after: cleared ? [0, 0, 5, 6] : [44, 0, 5, 6],
      });
    }, 60_000);
  }

  // a house cell in state 10 east of the hero, floor behind it
  for (const [id, flag, blocks] of [
    [114, true, true],
    [114, false, false],
    [41, true, false],
  ] as const) {
    test(`episode III room ${String(id)}: a house cell in state 10 ${blocks ? "blocks" : "lets the hero on"} ${flag ? "with" : "without"} flag 0x40000`, async () => {
      const ep = game.episode(3);
      const room = calmRoom(game.room(3, id), ep.classes);
      const base = room.base.slice();
      const overlay = room.overlay.slice();
      const [x, y] = [14, 22];
      for (let k = 0; k < 6; k++) base[at(x + k, y)] = overlay[at(x + k, y)] = 0;
      base[at(x + 2, y)] = 0x53 | (10 << 8); // class 98, state 10
      const flags = readEpisodeFlags(game.image, 3) & ~(flag ? 0 : 0x40000);
      const mod: Mod = {
        ...emptyMod(game.image.data),
        changes: {
          ...NO_CHANGES,
          rooms: [{ episode: 3, id, room: { ...room, base, overlay } }],
          start: [{ episode: 3, room: id, x: x + 1, y }],
          flags: [{ episode: 3, flags: flags >>> 0 }],
        },
      };
      const hero = await withModExe(game, mod, (exe) =>
        withGame(exe, async (d) => {
          await d.startEpisode(3);
          await d.hold("right", 30);
          await d.run(30);
          return d.hero();
        }),
      );
      assert.equal((hero?.x ?? 0) > x + 1, !blocks);
    }, 60_000);
  }

  test("episode II with the backdrop rule of IV: room 244 shows 144 behind it", async () => {
    const ep = game.episode(2);
    const house = calmRoom(game.room(2, 115), ep.classes);
    // without its script, which lays eggs in the house's corners on the first visit
    const room = { ...house, id: 244, tags: house.tags.filter((t) => t.kind !== 6) };
    const mod: Mod = {
      ...emptyMod(game.image.data),
      changes: {
        ...NO_CHANGES,
        rooms: [{ episode: 2, id: 244, room }],
        start: [{ episode: 2, room: 244, x: 21, y: 9 }],
        backdrop: [{ episode: 2, rule: "minus100" }],
      },
    };
    const rooms = [...ep.rooms, room];
    const render = (rule: BackdropRule) => {
      const classes = { ...ep.classes, backdropRule: rule };
      return renderRoom(room, ep.objects, classes, backdropRoom(room, rooms, classes));
    };
    assert.ok(
      differingCells(render("mod100"), render("minus100")).length > 100,
      "44 and 144 differ",
    );
    const frame = await withModExe(game, mod, (exe) =>
      withGame(exe, async (d) => {
        await d.startEpisode(2);
        await d.run(20);
        return d.frame();
      }),
    );
    // not in our render: the hero at (21, 9) and 144's type 0x4d (frame method 0x4127a0,
    // a renderer gap, see the open items)
    const behind = game.room(2, 144);
    const gaps = [[21, 9]];
    for (let i = 0; i < ROOM_CELLS; i++) {
      if ((behind.base[i] ?? 0) % 0x100 === 0x4d && room.base[i] === 0x54)
        gaps.push([i % ROOM_WIDTH, Math.floor(i / ROOM_WIDTH)]);
    }
    const seen = differingCells(frame.indices, render("minus100"));
    assert.deepEqual(
      seen.toSorted((a, b) => a[1] - b[1] || a[0] - b[0]),
      gaps.toSorted((a, b) => a[1] - b[1] || a[0] - b[0]),
    );
  }, 60_000);

  for (const diagonal of [false, true]) {
    test(`Junior: the hero ${diagonal ? "walks diagonally with III's step method" : "does not walk diagonally"}`, async () => {
      const hero = { x: 5, y: 15 };
      const area = { x0: 2, x1: 10, y0: 12, y1: 19 };
      const changes = { moves: diagonal ? [{ episode: 0, diagonal }] : [] };
      const mod = startRoomMod(game, 0, changes, area, hero, () => undefined);
      const after = await withModExe(game, mod, (exe) =>
        withGame(exe, async (d) => {
          await d.startEpisode(0);
          await d.key(34, true); // PgDn: down and right (DOS key 0x151)
          await d.run(20);
          await d.key(34, false);
          await d.run(30);
          return d.hero();
        }),
      );
      assert.deepEqual(after, diagonal ? { room: 43, x: 7, y: 17 } : { room: 43, ...hero });
    }, 60_000);
  }

  test("episode III: the rucksack holds a weight below its capacity", async () => {
    // shovel, hammer, axe, bucket, sextant: weight 2 each (their shapes' frame word)
    const items = [0x69, 0x62, 0x61, 0x67, 0x23];
    const start = readEpisodeStart(game.image, 3);
    const area = { x0: start.x + 1, x1: start.x + 8, y0: start.y, y1: start.y };
    const changes = {
      rucksack: [{ episode: 3, capacity: 6 }],
      // no first-take boxes
      texts: items.map((n) => ({ resource: eventTextsId(3), entry: 1800 + n, variants: null })),
    };
    const mod = startRoomMod(game, 3, changes, area, start, (set) => {
      items.forEach((item, k) => {
        set(start.x + 1 + k, start.y, item);
      });
    });
    const seen = await withModExe(game, mod, (exe) =>
      withGame(exe, async (d) => {
        await d.startEpisode(3);
        // onto the third, which stays: message 998 ("Zum Tragen ist das mindestens eins zu
        // viel.") waits for Return
        await d.hold("right", 120);
        await d.run(30);
        const third = await d.peek(MAP + 2 * at(start.x + 3, start.y), 2);
        const slots = await d.peek(0x4fe0c0, 2 + 2 * 6);
        const words = Array.from({ length: 7 }, (_, k) => slots[2 * k] | (slots[2 * k + 1] << 8));
        return { words, hero: await d.hero(), third: third[0] | (third[1] << 8) };
      }),
    );
    // capacity 6 and the slots (class | state << 8): two items, 2 + 2 + 2 would reach 6;
    // with the original 200 the hero takes all five
    assert.deepEqual(seen, {
      words: [6, 0x78, 0xb4, 0, 0, 0, 0],
      hero: { room: start.room, x: start.x + 3, y: start.y },
      third: game.episode(3).classes.classes.get(items[2])?.id, // the map holds classes
    });
  }, 60_000);

  test("episode II: class 99 under an object, in another state or a logic cell shows no backdrop", async () => {
    const [KEY, BURIED] = [0x15, 3];
    const probes = [at(16, 5), at(18, 5), at(16, 7)];
    const seen = await backdropCells(game, (base, overlay) => {
      const wall = base[at(17, 6)] ?? 0; // class 99, state 0: room 15's wall shows there
      overlay[at(16, 5)] = KEY;
      base[at(18, 5)] = wall | 0x1000; // still frame 0 (state & 0xf)
      base[at(16, 7)] = LOGIC_CELL; // slot 0: room 115 has no records
      return [{ slot: 0, data: Uint8Array.of(BURIED, 0, wall, 0, KEY, 0, 0, 0, 0, 0) }];
    });
    assert.deepEqual(seen.edited, probes, "our render no longer shows room 15 there");
    assert.deepEqual(seen.game, [HERO], "the game draws as we do");
  }, 60_000);

  test("episode II: marks in another state give no backdrop", async () => {
    const seen = await backdropCells(game, (base) => {
      for (const mark of [at(0, 1), at(39, 1)]) base[mark] = (base[mark] ?? 0) | 0x1000;
      return [];
    });
    assert.ok(seen.edited.length > 100, "our render shows no room 15");
    assert.deepEqual(seen.game, [HERO], "the game draws as we do");
  }, 60_000);
});
