import { expect, test } from "vitest";

import { readEventTable } from "../src/events.ts";
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
