import assert from "node:assert/strict";

import { test } from "vitest";

import { parseOmf, writeOmf } from "../src/omf.ts";
import { type Shape, TRANSPARENT, parseShapes, shapePixels, withShapes } from "../src/shapes.ts";
import { resources, snapshot } from "./data.ts";

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

  test(`SHAPES ${id} is written back byte for byte`, () => {
    const written = writeOmf(parseOmf(data));
    assert.ok(
      Buffer.from(written).equals(data),
      `${written.length} bytes written, ${data.length} read`,
    );
  });
}

const shapes = (id: string) => all.find((r) => r.id === id)?.data ?? new Uint8Array();
const objects = (data: Uint8Array) => parseShapes(data).get("_Rob_object") ?? [];

test("withShapes grows a table: episode II's tangram and oracle in Junior", () => {
  const junior = shapes("1002");
  const ii = objects(shapes("1202"));
  const added = new Map([
    [0x50, ii[0x50] ?? null],
    [0x51, ii[0x51] ?? null],
  ]);
  const written = withShapes(junior, "_Rob_object", added);
  const before = objects(junior);
  const after = objects(written);
  assert.equal(before.length, 57);
  assert.equal(after.length, 0x52);
  assert.deepEqual(after.slice(0, 57), before);
  assert.ok(after.slice(57, 0x50).every((s) => s === null));
  assert.ok(ii[0x50] && ii[0x51]);
  assert.deepEqual(after[0x50], ii[0x50]);
  assert.deepEqual(after[0x51], ii[0x51]);
  assert.ok(Buffer.from(writeOmf(parseOmf(written))).equals(written));
});

test("withShapes rewrites and empties slots in place, fills empty ones", () => {
  const junior = shapes("1002");
  const oracle = objects(shapes("1202"))[0x51] ?? null;
  const before = objects(junior);
  const after = objects(
    withShapes(
      junior,
      "_Rob_object",
      new Map([
        [0x10, oracle],
        [0x11, null],
      ]),
    ),
  );
  assert.equal(after.length, before.length);
  assert.deepEqual(after[0x10], oracle);
  assert.equal(after[0x11], null);
  assert.deepEqual(
    after.filter((_, i) => i !== 0x10 && i !== 0x11),
    before.filter((_, i) => i !== 0x10 && i !== 0x11),
  );
  // episode IV's table has empty slots (0x6d-0x74) inside it
  const iv = shapes("1402");
  assert.equal(objects(iv)[0x6d], null);
  const filled = objects(withShapes(iv, "_Rob_object", new Map([[0x6d, oracle]])));
  assert.equal(filled.length, objects(iv).length);
  assert.deepEqual(filled[0x6d], oracle);
  assert.throws(() => withShapes(junior, "_Nothing", new Map()), RangeError);
});

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
