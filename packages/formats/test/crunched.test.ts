import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeCp437 } from "../src/cp437.ts";
import { CrunchedFormatError, SYMBOL_TABLE_SIZE, uncrunch } from "../src/crunched.ts";
import { assertBytesEqual, golden, goldenJson, resources } from "./data.ts";

const all = resources("CRUNCHED");

test("finds all 15 CRUNCHED resources", () => {
  assert.equal(all.length, 15);
});

for (const { id, data } of all) {
  test(`CRUNCHED ${id} matches the Python decoder`, () => {
    const result = uncrunch(data);
    const header = goldenJson(`crunched/${id}.json`) as Record<string, number>;
    assert.equal(result.marker, header["marker"]);
    assert.equal(result.size, header["size"]);
    assert.equal(result.entryCount, header["count"]);
    assert.equal(result.text.length, result.size); // the stream decodes completely
    assertBytesEqual(result.text, golden(`crunched/${id}.bin`), `CRUNCHED ${id}`);
  });
}

test("episode list starts with a version line and episode 1000", () => {
  const entry = all.find((r) => r.id === "9901");
  assert.ok(entry);
  const lines = decodeCp437(uncrunch(entry.data).text).split("\n");
  assert.equal(lines[0], "1.0");
  assert.equal(lines[1], "1000:1");
});

test("rejects data shorter than the header", () => {
  assert.throws(() => uncrunch(new Uint8Array(SYMBOL_TABLE_SIZE + 5)), CrunchedFormatError);
});

test("a bitstream that ends early yields the text decoded so far", () => {
  const table = Uint8Array.from({ length: SYMBOL_TABLE_SIZE }, (_, i) => 0x41 + (i % 26));
  // header: marker, size 10, 1 entry; stream: one byte = codes "0 01" twice ("A", "A")
  const header = [0x55, 0x55, 10, 0, 1, 0];
  const result = uncrunch(Uint8Array.from([...table, ...header, 0b0001_0010]));
  assert.equal(result.size, 10);
  assert.deepEqual([...result.text], [0x41, 0x41]);
});
