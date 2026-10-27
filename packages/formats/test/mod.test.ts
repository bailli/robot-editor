import assert from "node:assert/strict";

import { expect, test } from "vitest";

import { readClassTable } from "../src/classes.ts";
import { Game } from "../src/game.ts";
import {
  type Mod,
  type ModChanges,
  ModError,
  NO_CHANGES,
  applyMod,
  compileMod,
  emptyMod,
  modJson,
  parseMod,
} from "../src/mod.ts";
import { type PeImage, readVa } from "../src/pe.ts";
import { readResources } from "../src/resources.ts";
import { ROOM_WIDTH, type Room } from "../src/scene.ts";
import { readEpisodeStart, withEpisodeStart } from "../src/start.ts";
import { withTextEntry } from "../src/texts.ts";
import { exe } from "./data.ts";

const game = new Game(exe());
const mod = (changes: Partial<ModChanges>): Mod => ({
  ...emptyMod(exe(), "test"),
  changes: { ...NO_CHANGES, ...changes },
});

/** Room 41 of episode III with one cell changed, and a new room 300 made from room 3. */
const room41: Room = (() => {
  const room = game.room(3, 41);
  const base = room.base.slice();
  base[2 + 16 * ROOM_WIDTH] = 0x0a59;
  return { ...room, base };
})();
const room300: Room = { ...game.room(3, 3), id: 300 };

const changes: ModChanges = {
  tileTypes: [
    {
      episode: 3,
      from: 1,
      // in key order, as the mod applies them (withShapes appends in the order given)
      types: [
        [0x40, 0x25],
        [0x43, 0x43],
        [0x59, 0x42],
      ],
    },
  ],
  code: [],
  // after tileTypes: the copied description of 0x59 gives way to this one
  texts: [
    { resource: 1310, entry: 0x59, variants: ["Ein Gatter."] },
    { resource: 1310, entry: 0x5b, variants: null },
  ],
  rooms: [
    { episode: 3, id: 41, room: room41 },
    { episode: 3, id: 300, room: room300 },
    { episode: 3, id: 3, room: null },
  ],
  start: [{ episode: 3, room: 41, x: 2, y: 16 }],
};

/** Same resources (by type, name, language) and same bytes outside them. */
function sameContent(a: PeImage, b: PeImage): void {
  const resources = (image: PeImage) =>
    new Map(readResources(image).map((r) => [`${r.type}/${r.name}/${r.language}`, r.data]));
  const [ra, rb] = [resources(a), resources(b)];
  assert.deepEqual([...ra.keys()], [...rb.keys()]);
  for (const [key, data] of ra) {
    assert.ok(Buffer.from(data).equals(rb.get(key) ?? new Uint8Array()), key);
  }
  for (const s of a.sections.filter((s) => s.name !== ".rsrc")) {
    const bytes = (image: PeImage) => image.data.subarray(s.rawOffset, s.rawOffset + s.rawSize);
    assert.ok(Buffer.from(bytes(a)).equals(bytes(b)), s.name);
  }
}

test("a mod applies its changes as the editing functions do, in the order of kinds", () => {
  const modded = new Game(applyMod(game.image, mod(changes)));
  // what the same edits make when done by hand
  let direct = new Game(game.withTileTypes(3, 1, new Map(changes.tileTypes[0]?.types)));
  let text = direct.textSource(1310) ?? "";
  text = withTextEntry(withTextEntry(text, 0x59, ["Ein Gatter."]), 0x5b, undefined);
  direct = new Game(direct.withText(1310, text));
  const rooms = direct
    .episode(3)
    .rooms.filter((r) => r.id !== 3)
    .map((r) => (r.id === 41 ? room41 : r));
  direct = new Game(
    direct.withScene(
      3,
      [...rooms, room300].sort((a, b) => a.id - b.id),
    ),
  );
  const start = { room: 41, x: 2, y: 16 };
  direct = new Game(withEpisodeStart(direct.image, 3, start));
  sameContent(modded.image, direct.image);

  expect(modded.episode(3).classes.typeOfClass.get(76)).toBe(0x59);
  expect(modded.episodeTexts(3)?.entries.get(0x59)).toEqual(["Ein Gatter."]);
  expect(modded.room(3, 41)).toEqual(room41);
  expect(modded.room(3, 300)).toEqual(room300);
  expect(modded.episode(3).rooms.some((r) => r.id === 3)).toBe(false);
  expect(readEpisodeStart(modded.image, 3)).toEqual(start);
  for (const e of [0, 1, 2, 4]) {
    expect(modded.episode(e).rooms).toEqual(game.episode(e).rooms);
  }
});

test("compiled: byte writes in the tables and the start method, whole resources", () => {
  const patch = compileMod(game.image, mod(changes));
  const within = (va: number, start: number, length: number) => va >= start && va < start + length;
  for (const { va, bytes } of patch.writes) {
    const end = va + bytes.length - 1;
    const tables = [
      [0x477ca0, 8 * 128], // III's class table
      [0x4780d8, 12 * 187], // III's event table
      [0x40b460, 23], // III's start method
    ] as const;
    assert.ok(
      tables.some(([start, length]) => within(va, start, length) && within(end, start, length)),
      `write at 0x${va.toString(16)}`,
    );
  }
  expect(patch.resources.map((r) => `${r.type}/${r.name}`).sort()).toEqual([
    "CRUNCHED/1306",
    "CRUNCHED/1310",
    "CRUNCHED/1320",
    "SCENE/1304",
    "SHAPES/1302",
  ]);
  expect(compileMod(game.image, mod({}))).toEqual({ writes: [], resources: [] });
});

test("code changes write where the exe holds what they expect", () => {
  // III's start method: the hero's x (c6 05 09 e3 4f 00 xx)
  const va = 0x40b460 + 6;
  const [x] = readVa(game.image, va, 1);
  const change = { va, expect: Uint8Array.of(x), bytes: Uint8Array.of(5) };
  const modded = new Game(applyMod(game.image, mod({ code: [change] })));
  expect(readEpisodeStart(modded.image, 3).x).toBe(5);
  const wrong = { ...change, expect: Uint8Array.of(x + 1) };
  expect(() => applyMod(game.image, mod({ code: [wrong] }))).toThrow(/code\[0\].*the exe holds/);
  const outside = { va: 0x10, expect: Uint8Array.of(0), bytes: Uint8Array.of(1) };
  expect(() => applyMod(game.image, mod({ code: [outside] }))).toThrow(/no initialised data/);
});

test("the file: saving again gives the same file, in key order", () => {
  const json = modJson(mod(changes));
  const shuffled = mod({
    ...changes,
    tileTypes: changes.tileTypes.map((c) => ({ ...c, types: c.types.toReversed() })),
    texts: changes.texts.toReversed(),
    rooms: changes.rooms.toReversed(),
  });
  expect(modJson(shuffled)).toBe(json);
  const loaded = parseMod(json);
  expect(modJson(loaded)).toBe(json);
  expect(loaded.changes.rooms.find((c) => c.id === 41)?.room).toEqual(room41);
  sameContent(
    new Game(applyMod(game.image, loaded)).image,
    new Game(applyMod(game.image, mod(changes))).image,
  );
  expect(JSON.parse(json)).toMatchObject({ format: 1, base: { sha256: emptyMod(exe()).base } });
  expect(json).toContain("[64, 37]");
  // texts keep their brackets and spaces
  const text = { resource: 1310, entry: 1, variants: ["[\n 1,\n 2\n] [ 3,  4 ]"] };
  expect(parseMod(modJson(mod({ texts: [text] }))).changes.texts).toEqual([text]);
});

test("refused: another exe, keys changed twice, bad values, broken files", () => {
  const other = game.withText(1310, `${game.textSource(1310) ?? ""}\n`);
  expect(() => applyMod(new Game(other).image, mod({}))).toThrow(
    /base: the mod is for another exe/,
  );
  const twice = { ...changes, start: [...changes.start, ...changes.start] };
  expect(() => applyMod(game.image, mod(twice))).toThrow(/start\[1\].*changed twice/);
  const bad: Partial<ModChanges>[] = [
    { texts: [{ resource: 1310, entry: 1, variants: ["a|b"] }] },
    { texts: [{ resource: 1399, entry: 1, variants: ["a"] }] },
    { rooms: [{ episode: 3, id: 999, room: null }] },
    { rooms: [{ episode: 3, id: 42, room: room41 }] },
    { rooms: [{ episode: 5, id: 41, room: null }] },
    { tileTypes: [{ episode: 3, from: 3, types: [[0x40, 0x40]] }] },
    { start: [{ episode: 3, room: 41, x: 40, y: 0 }] },
    {
      code: [
        { va: 0x40b460, expect: new Uint8Array(4), bytes: new Uint8Array(4) },
        { va: 0x40b462, expect: new Uint8Array(1), bytes: new Uint8Array(1) },
      ],
    },
  ];
  for (const c of bad) expect(() => applyMod(game.image, mod(c))).toThrow(ModError);
  for (const text of [
    "{",
    "[]",
    '{"format":2}',
    '{"format":1,"base":{"sha256":"x"}}',
    `{"format":1,"base":{"sha256":"${"0".repeat(64)}"},"changes":{"rooms":[{"episode":3,"id":1,"scene":"!"}]}}`,
  ]) {
    expect(() => parseMod(text)).toThrow(ModError);
  }
  expect(() =>
    parseMod(
      `{"format":1,"base":{"sha256":"${"0".repeat(64)}"},"changes":{"texts":[{"resource":1310,"entry":"1"}]}}`,
    ),
  ).toThrow("texts[0].entry: not an integer");
  expect(readClassTable(game.image, 3)).toEqual(readClassTable(new Game(exe()).image, 3));
});
