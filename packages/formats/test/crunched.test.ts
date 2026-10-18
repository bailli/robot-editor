import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeCp437 } from "../src/cp437.ts";
import { uncrunch } from "../src/crunched.ts";
import { golden, goldenJson, resources } from "./data.ts";

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
    assert.equal(result.text.length, result.size);
    assert.deepEqual(result.text, golden(`crunched/${id}.bin`));
  });
}

test("episode list starts with a version line and episode 1000", () => {
  const entry = all.find((r) => r.id === "9901");
  assert.ok(entry);
  const lines = decodeCp437(uncrunch(entry.data).text).split("\n");
  assert.equal(lines[0], "1.0");
  assert.equal(lines[1], "1000:1");
});

test("rejects truncated input", () => {
  assert.throws(() => uncrunch(new Uint8Array(10)), RangeError);
});
