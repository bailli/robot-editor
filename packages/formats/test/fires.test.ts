import { expect, test } from "vitest";

import { hasLastingFires, readLastingFires, withLastingFires } from "../src/fires.ts";
import { EPISODES, Game } from "../src/game.ts";
import { parsePe, readVa } from "../src/pe.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("fires burn until put out only in III (its path) and IV (its own)", () => {
  expect(EPISODES.map((e) => hasLastingFires(game.image, e))).toEqual([
    false,
    false,
    false,
    true,
    true,
  ]);
  expect(readLastingFires(game.image)).toBe(0b1000);
  // the stub's place in the padding of .text, after the room 255 one, is free
  expect(readVa(game.image, 0x465e80, 0x16).every((b) => b === 0)).toBe(true);
});

test("the check jumps to a stub testing the episode's bit; III alone gives the exe's bytes", () => {
  const junior = parsePe(withLastingFires(game.image, 0, true));
  expect(EPISODES.map((e) => hasLastingFires(junior, e))).toEqual([true, false, false, true, true]);
  // jmp 0x465e80, four nops
  expect([...readVa(junior, 0x4350bb, 9)]).toEqual([
    0xe9, 0xc0, 0x0d, 0x03, 0x00, 0x90, 0x90, 0x90, 0x90,
  ]);
  // bt [0x465e92], eax; jc 0x4350c4; jmp 0x4352d9; the mask
  expect([...readVa(junior, 0x465e80, 0x16)]).toEqual([
    ...[0x0f, 0xa3, 0x05, 0x92, 0x5e, 0x46, 0x00],
    ...[0x0f, 0x82, 0x37, 0xf2, 0xfc, 0xff],
    ...[0xe9, 0x47, 0xf4, 0xfc, 0xff],
    ...[0x09, 0x00, 0x00, 0x00],
  ]);
  // none: III's fires burn out too
  const none = parsePe(withLastingFires(parsePe(withLastingFires(junior, 3, false)), 0, false));
  expect(readLastingFires(none)).toBe(0);
  expect(hasLastingFires(none, 4)).toBe(true);
  const back = withLastingFires(none, 3, true);
  expect(Buffer.from(back).equals(Buffer.from(game.image.data))).toBe(true);
  expect(withLastingFires(game.image, 3, true)).toEqual(game.image.data);
  expect(() => withLastingFires(game.image, 4, false)).toThrow(RangeError);
  expect(() => hasLastingFires(game.image, 5)).toThrow(RangeError);
});
