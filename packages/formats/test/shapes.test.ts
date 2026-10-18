import assert from "node:assert/strict";
import { test } from "node:test";

import { OmfFormatError, parseOmf } from "../src/omf.ts";
import { type Shape, TRANSPARENT, parseShapes, planeBit, shapePixels } from "../src/shapes.ts";
import { goldenJson, resource, resources } from "./data.ts";

interface GoldenShape {
  width: number;
  height: number;
  bytesPerRow: number;
  colours: number[];
  unknown: number;
  frames: { word: number; masks: (string | null)[] }[];
}

function maskString(shape: Shape, plane: Uint8Array): string {
  let s = "";
  for (let y = 0; y < shape.height; y++) {
    for (let x = 0; x < shape.width; x++) s += planeBit(shape, plane, x, y) ? "1" : "0";
  }
  return s;
}

const all = resources("SHAPES");

test("finds all 12 SHAPES resources", () => {
  assert.equal(all.length, 12);
});

for (const { id, data } of all) {
  test(`SHAPES ${id} matches the Python decoder`, () => {
    const expected = goldenJson(`shapes/${id}.json`) as Record<string, (GoldenShape | null)[]>;
    const tables = parseShapes(data);
    assert.deepEqual([...tables.keys()].sort(), Object.keys(expected).sort());
    for (const [name, table] of tables) {
      const want = expected[name];
      assert.ok(want);
      assert.equal(table.length, want.length, `${name} length`);
      table.forEach((shape, i) => {
        const w = want[i];
        if (!shape || !w) {
          assert.equal(shape, w ?? null, `${name}[${i}]`);
          return;
        }
        assert.deepEqual(
          {
            width: shape.width,
            height: shape.height,
            bytesPerRow: shape.bytesPerRow,
            colours: [...shape.colours],
            unknown: shape.unknown,
            frames: shape.frames.map((f) => ({
              word: f.word,
              masks: f.planes.map((p) => (p ? maskString(shape, p) : null)),
            })),
          },
          w,
          `${name}[${i}]`,
        );
      });
    }
  });
}

test("episode 1 objects: 127 slots, tile 6 is a 6-frame wall", () => {
  const objects = parseShapes(resource("SHAPES", "1102")).get("_Rob_object");
  assert.ok(objects);
  assert.equal(objects.length, 127);
  const wall = objects[6];
  assert.ok(wall);
  assert.equal(wall.frames.length, 6);
  assert.deepEqual(wall.colours, [3, 6, 1]);
});

test("shapePixels XORs plane colours onto the background", () => {
  const plane = new Uint8Array([0b11000000, 0b10000000]); // 2x2: row 0 both, row 1 left
  const shape: Shape = {
    width: 2,
    height: 2,
    bytesPerRow: 1,
    colours: [6, 1, 0],
    unknown: 0,
    frames: [{ word: 0, planes: [plane, new Uint8Array([0b01000000, 0]), null, null] }],
  };
  assert.deepEqual([...shapePixels(shape)], [15 ^ 6, 15 ^ 6 ^ 1, 15 ^ 6, TRANSPARENT]);
  assert.deepEqual([...shapePixels(shape, 0, 0)], [6, 7, 6, TRANSPARENT]);
});

test("rejects truncated OMF data", () => {
  const data = resource("SHAPES", "1001");
  assert.throws(() => parseOmf(data.subarray(0, 100)), OmfFormatError);
});
