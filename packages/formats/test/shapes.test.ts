import assert from "node:assert/strict";
import { test } from "node:test";

import { type Shape, TRANSPARENT, parseShapes, shapePixels } from "../src/shapes.ts";
import { resources, snapshots } from "./data.ts";

const snapshot = snapshots(import.meta.url);

const all = resources("SHAPES");

test("finds all 12 SHAPES resources", () => {
  assert.equal(all.length, 12);
});

for (const { id, data } of all) {
  test(`SHAPES ${id} decodes`, () => {
    const tables = Object.fromEntries(parseShapes(data));
    assert.ok(Object.keys(tables).length > 0);
    snapshot(id, tables);
  });
}

test("shapePixels XORs plane colours onto the background", () => {
  // 2x2 pixels: plane 0 covers row 0 and the bottom-left pixel, plane 1 the top-right
  // one. Plane 3 is set everywhere but is not drawn by the game.
  const shape: Shape = {
    width: 2,
    height: 2,
    bytesPerRow: 1,
    colours: [6, 1, 0],
    unknown: 0,
    frames: [
      {
        word: 0,
        planes: [
          Uint8Array.of(0b11000000, 0b10000000),
          Uint8Array.of(0b01000000, 0),
          null,
          Uint8Array.of(0xff, 0xff),
        ],
      },
    ],
  };
  assert.deepEqual([...shapePixels(shape)], [15 ^ 6, 15 ^ 6 ^ 1, 15 ^ 6, TRANSPARENT]);
  assert.deepEqual([...shapePixels(shape, 0, 0)], [6, 7, 6, TRANSPARENT]);
  // Like the game's four bitplanes, results keep only 4 bits, even with odd overrides.
  assert.deepEqual([...shapePixels(shape, 0, 15, [0x36, 0x10, 0])], [9, 9, 9, TRANSPARENT]);
  assert.throws(() => shapePixels(shape, 1), RangeError);
});
