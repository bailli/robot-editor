import assert from "node:assert/strict";
import { test } from "node:test";

import { OmfFormatError, parseOmf } from "../src/omf.ts";
import { parseShapes, planeBit } from "../src/shapes.ts";
import { fixup, fixupp, ledata, lnames, omf, pubdef, record, segdef } from "./omf-builder.ts";

/**
 * One 8x2 shape in _Test: descriptor at DATA 0, an empty descriptor at 12, the frame at 24.
 * Its plane pointer stores offset 0 with a fixup displacement of 2, so the plane is
 * TEXT[2..3] = [0x80, 0x01], not TEXT[0..1] = [0xff, 0xff].
 */
function shapeModule(planeDisplacement: number) {
  const descriptor = [8, 2, 0, 0, 1, 1, 24, 0, 6, 1, 0, 0];
  const frame = [0, 0, 0, 0, 0, 0, ...Array<number>(12).fill(0)];
  return omf(
    lnames("_TEXT", "CODE", "_DATA", "DATA"),
    segdef(4, 1),
    segdef(42, 3),
    pubdef(2, "_Test", 0),
    ledata(1, 0, [0xff, 0xff, 0x80, 0x01]),
    ledata(2, 0, [...descriptor, ...Array<number>(12).fill(0), ...frame]),
    fixupp(fixup(6, 1, 2), fixup(26, 3, 1, planeDisplacement)),
  );
}

test("plane pointers include the fixup displacement", () => {
  const table = parseShapes(shapeModule(2)).get("_Test");
  assert.ok(table);
  assert.equal(table.length, 1);
  const shape = table[0];
  assert.ok(shape);
  const plane = shape.frames[0]?.planes[0];
  assert.ok(plane);
  assert.deepEqual([...plane], [0x80, 0x01]);
  assert.ok(planeBit(shape, plane, 0, 0));
  assert.ok(!planeBit(shape, plane, 1, 0));
  assert.ok(planeBit(shape, plane, 7, 1));
});

test("without displacement the stored offset is used", () => {
  const plane = parseShapes(shapeModule(0)).get("_Test")?.[0]?.frames[0]?.planes[0];
  assert.deepEqual(plane && [...plane], [0xff, 0xff]);
});

test("SEGDEF: 'big' segments are 64 KiB, absolute segments skip frame and offset", () => {
  const module = parseOmf(
    omf(
      lnames("_BIG", "_ABS"),
      segdef(0, 1, [0x62]), // A=3, B=1, length 0
      segdef(16, 2, [0x00, 0x34, 0x12, 0x00]), // A=0: frame 0x1234, offset 0
    ),
  );
  assert.equal(module.segments[1]?.name, "_BIG");
  assert.equal(module.segments[1]?.data.length, 0x10000);
  assert.equal(module.segments[2]?.name, "_ABS");
  assert.equal(module.segments[2]?.data.length, 16);
});

for (const [bit, name] of [
  [0x80, "frame"],
  [0x08, "target"],
] as const) {
  test(`rejects fixups that refer to a ${name} thread`, () => {
    const thread = [0xc4, 0x00, bit | 0x04, 0x01];
    const data = omf(lnames("_TEXT"), segdef(4, 1), ledata(1, 0, [0, 0, 0, 0]), fixupp(thread));
    assert.throws(() => parseOmf(data), OmfFormatError);
  });
}

test("rejects a truncated record", () => {
  const data = shapeModule(0);
  assert.throws(() => parseOmf(data.subarray(0, data.length - 10)), OmfFormatError);
});

test("rejects THREAD subrecords and LEDATA outside its segment", () => {
  const thread = omf(lnames("_TEXT"), segdef(4, 1), ledata(1, 0, [0]), record(0x9c, [0x00, 0x01]));
  assert.throws(() => parseOmf(thread), OmfFormatError);
  const outside = omf(lnames("_TEXT"), segdef(2, 1), ledata(1, 1, [0, 0]));
  assert.throws(() => parseOmf(outside), OmfFormatError);
});
