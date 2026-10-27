import { expect, test } from "vitest";

import { readEventTable, withEventEntries } from "../src/events.ts";
import { EPISODES, Game } from "../src/game.ts";
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
