import assert from "node:assert/strict";

import { test } from "vitest";

import {
  EMPTY_CLASS_OBJECT,
  FrameMethod,
  SCORPION_SAND_TOUCH_METHODS,
  freeTileTypes,
  readClassTable,
  readEpisodeClasses,
  withClassEntries,
} from "../src/classes.ts";
import { parsePe, readVa } from "../src/pe.ts";
import { glyphRow } from "../src/render.ts";
import { exe } from "./data.ts";

const image = parsePe(exe());

test("glyph rows: bits 7..1 become 14 pixels at x = 2..15, bit 0 is dropped", () => {
  // As in the game (the letter cells match its screenshots): not centred.
  assert.equal(glyphRow(0xfe), 0b0011_1111_1111_1111);
  assert.equal(glyphRow(0x80), 0b0011_0000_0000_0000); // leftmost font pixel
  assert.equal(glyphRow(0x02), 0b0000_0000_0000_0011);
  assert.equal(glyphRow(0x01), 0);
});

test("episode 1 classes read from the exe", () => {
  const ep = readEpisodeClasses(image, 1);
  assert.deepEqual(ep.classes.get(6), {
    id: 6,
    frameMethod: FrameMethod.WALL,
    touchMethod: 0x420e60,
    heroTouch: 0x438d00,
    describeMethod: 0x41b160,
    loadMethod: 0x43ec50,
  });
  assert.equal(ep.classes.get(37)?.frameMethod, FrameMethod.LETTER);
  assert.equal(ep.typeOfClass.get(0x27), 49); // underlay 1 is class 0x27: the grass of type 49
  assert.deepEqual(ep.underlays[0], [0x27, 0]);
  assert.equal(ep.terrainPatterns.length, 16);
  assert.equal(ep.maskedPatterns.length, 32);
});

test("sand heaps hide scorpions in every episode but IV (verified in the game)", () => {
  const scorpions = [0, 1, 2, 3, 4].map((episode) => {
    const sand = readEpisodeClasses(image, episode).classes.get(episode === 0 ? 0x27 : 0x31);
    assert.equal(sand?.id, 39);
    return SCORPION_SAND_TOUCH_METHODS.has(sand.touchMethod);
  });
  assert.deepEqual(scorpions, [true, true, true, true, false]);
});

test("episode 0 has no underlay table; unknown episodes are rejected", () => {
  assert.deepEqual(readEpisodeClasses(image, 0).underlays, []);
  assert.throws(() => readEpisodeClasses(image, 5), RangeError);
  assert.throws(() => readEpisodeClasses(image, -1), RangeError);
});

test("free tile types: those pointing to the empty class", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((e) => freeTileTypes(image, e).length),
    [69, 47, 0, 18, 15],
  );
  assert.deepEqual(
    freeTileTypes(image, 0),
    Array.from({ length: 69 }, (_, i) => 0x39 + i),
  );
  const table = readClassTable(image, 3);
  assert.equal(table.length, 128);
  for (const type of freeTileTypes(image, 3)) {
    assert.deepEqual(table[type], { object: EMPTY_CLASS_OBJECT, extra: 0x33 });
    assert.equal(readEpisodeClasses(image, 3).classes.get(type)?.id, 0);
  }
});

test("withClassEntries: episode II's tangram and oracle in Junior, as in the pilot", () => {
  const ii = readClassTable(image, 2);
  const patched = parsePe(
    withClassEntries(
      image,
      0,
      new Map([
        [0x50, ii[0x50]],
        [0x51, ii[0x51]],
      ]),
    ),
  );
  // The 16 bytes the pilot copied by hand: Junior 0x479d58 from II 0x477080.
  assert.deepEqual(readVa(patched, 0x479d58, 16), readVa(image, 0x476e00 + 8 * 0x50, 16));
  const junior = readEpisodeClasses(patched, 0);
  assert.equal(junior.classes.get(0x50)?.id, 0x5f);
  assert.equal(junior.classes.get(0x51)?.id, 0x60);
  assert.equal(junior.typeOfClass.get(0x60), 0x51);
  assert.equal(freeTileTypes(patched, 0).length, 67);
  for (const e of [1, 2, 3, 4])
    assert.deepEqual(readClassTable(patched, e), readClassTable(image, e));
  const changed = patched.data.reduce((n, b, i) => n + Number(b !== image.data[i]), 0);
  assert.equal(changed, 2 * 2 + 2); // 0x4c777c -> 0x4c6758/0x4c6754, 0x33 -> 0x5f/0x60
});

test("withClassEntries: null frees a type; bad types, objects and episodes are rejected", () => {
  const freed = parsePe(withClassEntries(image, 2, new Map([[0x7d, null]])));
  assert.deepEqual(freeTileTypes(freed, 2), [0x7d]);
  assert.equal(readEpisodeClasses(freed, 2).typeOfClass.get(0x8c), undefined);
  const oracle = readClassTable(image, 2)[0x51];
  assert.throws(() => withClassEntries(image, 0, new Map([[128, oracle]])), RangeError);
  assert.throws(() => withClassEntries(image, 0, new Map([[-1, oracle]])), RangeError);
  assert.throws(
    () => withClassEntries(image, 0, new Map([[0x50, { ...oracle, object: 0x4c0000 }]])),
    RangeError,
  );
  assert.throws(
    () => withClassEntries(image, 0, new Map([[0x50, { ...oracle, extra: -1 }]])),
    RangeError,
  );
  assert.throws(() => withClassEntries(image, 5, new Map()), RangeError);
  assert.throws(() => readClassTable(image, 1.5), RangeError);
});
