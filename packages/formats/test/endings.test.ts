import { expect, test } from "vitest";

import { endsAtRoom255, readRoom255Endings, withRoom255Ending } from "../src/endings.ts";
import { EPISODES, Game } from "../src/game.ts";
import { parsePe, readVa } from "../src/pe.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("room 255 ends only episode I in the originals", () => {
  expect(EPISODES.map((e) => endsAtRoom255(game.image, e))).toEqual([
    false,
    true,
    false,
    false,
    false,
  ]);
  expect(readRoom255Endings(game.image)).toBe(0b10);
  // the stub's place in the padding of .text is free
  expect(readVa(game.image, 0x465e60, 0x20).every((b) => b === 0)).toBe(true);
});

test("the check jumps to a stub testing the episode's bit; I alone gives the exe's bytes", () => {
  const two = parsePe(withRoom255Ending(game.image, 2, true));
  expect(EPISODES.map((e) => endsAtRoom255(two, e))).toEqual([false, true, true, false, false]);
  expect([...readVa(two, 0x40283f, 5)]).toEqual([0xe9, 0x1c, 0x36, 0x06, 0x00]);
  expect(readRoom255Endings(two)).toBe(0b110);
  // none: episode I's ending is gone too
  const none = parsePe(withRoom255Ending(parsePe(withRoom255Ending(two, 1, false)), 2, false));
  expect(readRoom255Endings(none)).toBe(0);
  const back = withRoom255Ending(parsePe(withRoom255Ending(none, 1, true)), 4, false);
  expect(Buffer.from(back).equals(Buffer.from(game.image.data))).toBe(true);
  expect(withRoom255Ending(game.image, 1, true)).toEqual(game.image.data);
  expect(() => endsAtRoom255(game.image, 5)).toThrow(RangeError);
});
