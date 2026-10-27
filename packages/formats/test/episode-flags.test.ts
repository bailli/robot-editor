import { expect, test } from "vitest";

import {
  ORACLE_VANISHES_EAST,
  ORACLE_VANISHES_NORTH,
  readEpisodeFlags,
  withEpisodeFlags,
} from "../src/episode-flags.ts";
import { EPISODES, Game } from "../src/game.ts";
import { parsePe } from "../src/pe.ts";
import { exe } from "./data.ts";

const game = new Game(exe());
const oracles = ORACLE_VANISHES_NORTH | ORACLE_VANISHES_EAST;

test("the episodes' flags as their constructors set them; only II's oracles vanish", () => {
  const flags = EPISODES.map((e) => readEpisodeFlags(game.image, e));
  expect(flags).toEqual([0x48012946, 0x48012b46, 0x4901ed46, 0x75ce0533, 0x22312ccd]);
  expect(flags.map((f) => (f & oracles) === oracles)).toEqual([false, false, true, false, false]);
});

test("the flags change in the constructor's instruction only", () => {
  for (const e of EPISODES) {
    const flags = readEpisodeFlags(game.image, e) ^ oracles;
    const patched = parsePe(withEpisodeFlags(game.image, e, flags));
    expect(readEpisodeFlags(patched, e)).toBe(flags);
    const changed = patched.data.reduce((n, b, i) => n + Number(b !== game.image.data[i]), 0);
    expect(changed).toBe(1);
  }
  expect(() => withEpisodeFlags(game.image, 1, -1)).toThrow(RangeError);
  expect(() => withEpisodeFlags(game.image, 5, 0)).toThrow(RangeError);
});
