import assert from "node:assert/strict";
import { test } from "node:test";

import { FrameMethod, readEpisodeClasses } from "../src/classes.ts";
import { parsePe } from "../src/pe.ts";
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
  assert.deepEqual(ep.classes.get(6), { id: 6, frameMethod: FrameMethod.WALL });
  assert.equal(ep.classes.get(37)?.frameMethod, FrameMethod.LETTER);
  assert.equal(ep.typeOfClass.get(0x27), 49); // underlay 1 is class 0x27: the grass of type 49
  assert.deepEqual(ep.underlays[0], [0x27, 0]);
  assert.equal(ep.terrainPatterns.length, 16);
  assert.equal(ep.maskedPatterns.length, 32);
});

test("episode 0 has no underlay table; unknown episodes are rejected", () => {
  assert.deepEqual(readEpisodeClasses(image, 0).underlays, []);
  assert.throws(() => readEpisodeClasses(image, 5), RangeError);
  assert.throws(() => readEpisodeClasses(image, -1), RangeError);
});
