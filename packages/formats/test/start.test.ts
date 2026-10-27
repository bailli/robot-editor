import { expect, test } from "vitest";

import { EPISODES, Game, START_ROOMS } from "../src/game.ts";
import { parsePe } from "../src/pe.ts";
import {
  MAX_RUCKSACK,
  readEpisodeStart,
  readRucksack,
  withEpisodeStart,
  withRucksack,
} from "../src/start.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("the episodes start in their start rooms, at the hero's start", () => {
  expect(EPISODES.map((e) => readEpisodeStart(game.image, e))).toEqual([
    { room: 43, x: 2, y: 14 },
    { room: 43, x: 5, y: 14 },
    { room: 43, x: 6, y: 23 },
    { room: 41, x: 8, y: 15 },
    { room: 53, x: 13, y: 16 },
  ]);
  for (const e of EPISODES) expect(readEpisodeStart(game.image, e).room).toBe(START_ROOMS[e]);
});

test("the start can be moved to any room and cell", () => {
  const patched = parsePe(withEpisodeStart(game.image, 2, { room: 600, x: 39, y: 28 }));
  expect(readEpisodeStart(patched, 2)).toEqual({ room: 600, x: 39, y: 28 });
  for (const e of [0, 1, 3, 4]) {
    expect(readEpisodeStart(patched, e)).toEqual(readEpisodeStart(game.image, e));
  }
  const changed = patched.data.reduce((n, b, i) => n + Number(b !== game.image.data[i]), 0);
  expect(changed).toBe(4);
  expect(() => withEpisodeStart(game.image, 1, { room: 43, x: 40, y: 0 })).toThrow(RangeError);
  expect(() => withEpisodeStart(game.image, 5, { room: 43, x: 0, y: 0 })).toThrow(RangeError);
});

test("the rucksacks: their capacity, changed in the start method", () => {
  expect(EPISODES.map((e) => readRucksack(game.image, e))).toEqual([38, 50, 60, 200, 120]);
  const patched = parsePe(withRucksack(game.image, 3, MAX_RUCKSACK));
  expect(readRucksack(patched, 3)).toBe(250);
  expect(readEpisodeStart(patched, 3)).toEqual(readEpisodeStart(game.image, 3));
  const changed = patched.data.reduce((n, b, i) => n + Number(b !== game.image.data[i]), 0);
  expect(changed).toBe(1);
  expect(() => withRucksack(game.image, 3, 0)).toThrow(RangeError);
  expect(() => withRucksack(game.image, 3, MAX_RUCKSACK + 1)).toThrow(RangeError);
});
