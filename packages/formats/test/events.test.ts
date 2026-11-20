import { expect, test } from "vitest";

import {
  freeEventEntries,
  readEventTable,
  scriptEnigmaEntries,
  withEventEntries,
} from "../src/events.ts";
import { EPISODES, Game } from "../src/game.ts";
import { withRoomScript } from "../src/script.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("the event tables give points for first takes and events", () => {
  const tables = EPISODES.map((e) => readEventTable(game.image, e));
  expect(tables.map((t) => t.length)).toEqual([192, 192, 192, 187, 201]);
  // the first key taken in episode I: 500 points (seen in the game); its class is 21
  expect(tables[1]?.[21]).toEqual({ id: 21, points: 500 });
  // after the tile types: events from 256 on (episode III from 321)
  expect(tables.map((t) => t[128]?.id)).toEqual([256, 256, 256, 321, 256]);
  expect(tables[2]?.[112]).toEqual({ id: 127, points: 5000 });
  expect(() => readEventTable(game.image, 5)).toThrow(RangeError);
});

test("withEventEntries writes id and points; bad entries and episodes are rejected", () => {
  const patched = new Game(
    withEventEntries(game.image, 3, new Map([[0x59, { id: 76, points: 100 }]])),
  );
  const before = readEventTable(game.image, 3);
  const after = readEventTable(patched.image, 3);
  expect(after[0x59]).toEqual({ id: 76, points: 100 });
  expect(after.filter((_, n) => n !== 0x59)).toEqual(before.filter((_, n) => n !== 0x59));
  for (const e of [0, 1, 2, 4])
    expect(readEventTable(patched.image, e)).toEqual(readEventTable(game.image, e));
  const entry = { id: 1, points: 1 };
  expect(() => withEventEntries(game.image, 3, new Map([[187, entry]]))).toThrow(RangeError);
  expect(() => withEventEntries(game.image, 3, new Map([[-1, entry]]))).toThrow(RangeError);
  expect(() => withEventEntries(game.image, 3, new Map([[0, { id: 1, points: 2 ** 31 }]]))).toThrow(
    RangeError,
  );
  expect(() => withEventEntries(game.image, 5, new Map())).toThrow(RangeError);
});

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, k) => from + k);
const free = (g: Game, e: number) => freeEventEntries(g.image, e, g.episode(e).rooms);

test("freeEventEntries: entries whose event nothing in the episode uses", () => {
  // Junior: nothing uses 168, 169, 181, 188, 190 (id 0); the others' events only classes
  // it lacks use (the oracle's 134-143, the computer's 161, 162, 182-185, ...)
  expect(free(game, 0)).toEqual([
    131,
    ...range(134, 143),
    146,
    147,
    ...range(149, 151),
    159,
    161,
    162,
    ...range(165, 169),
    174,
    176,
    178,
    ...range(180, 188),
    190,
  ]);
  expect(free(game, 1)).toEqual([
    131,
    ...range(134, 143),
    147,
    ...range(149, 151),
    168,
    169,
    176,
    180,
    181,
    188,
    190,
  ]);
  // II: its oracles take 134-143, its script Enigma(181) entry 181, class 129 plays
  // 304's sound; III: the gems' 321-324 are raised by the take (0x42c1a1)
  expect(free(game, 2)).toEqual([168, 169, 170, 188]);
  expect(free(game, 3)).toEqual([186]);
  // IV: 186, 187, 189, 190 have texts but no script awards them; 197-200 are empty
  expect(free(game, 4)).toEqual([
    131, 134, 147, 154, 169, 170, 171, 174, 186, 187, 189, 190, 197, 198, 199, 200,
  ]);
});

test("freeEventEntries: rooms' scripts, copied classes, the pristine table", () => {
  // the entries IV's scripts award are free for rooms without those scripts
  expect(scriptEnigmaEntries(game.room(4, 63))).toEqual([180, 182]);
  expect(scriptEnigmaEntries(game.room(2, 683))).toEqual([112]);
  const iv = freeEventEntries(game.image, 4, []);
  expect(iv.filter((n) => !free(game, 4).includes(n))).toEqual([
    ...range(180, 185),
    188,
    ...range(191, 196),
  ]);
  // II's oracle copied into Junior (or about to be) uses the oracle events 262-277
  const oracle = new Game(game.withTileTypes(0, 2, new Map([[0x51, 0x51]])));
  const used = range(134, 143);
  expect(free(oracle, 0).filter((n) => used.includes(n))).toEqual([]);
  const running = freeEventEntries(game.image, 0, game.episode(0).rooms, game.image, [0x467d90]);
  expect(running).toEqual(free(oracle, 0));
  // an entry a mod gave another event is judged by the event it held
  const patched = new Game(
    withEventEntries(game.image, 0, new Map([[168, { id: 300, points: 1 }]])),
  );
  expect(freeEventEntries(patched.image, 0, game.episode(0).rooms, game.image)).toContain(168);
  expect(free(patched, 0)).not.toContain(168);
  // a script whose Enigma takes a variable could award any entry
  const rooms = game.episode(0).rooms;
  const computed = [withRoomScript(rooms[0], "Enigma(Val1);"), ...rooms.slice(1)];
  expect(scriptEnigmaEntries(computed[0])).toBeUndefined();
  expect(freeEventEntries(game.image, 0, computed)).toEqual([]);
});
