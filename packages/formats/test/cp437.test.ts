import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeCp437, encodeCp437 } from "../src/cp437.ts";
import { goldenJson } from "./data.ts";

const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);

test("decodes all 256 bytes like Python's cp437 codec", () => {
  assert.equal(decodeCp437(ALL_BYTES), goldenJson("cp437.json"));
});

test("round-trips all 256 bytes", () => {
  assert.deepEqual(encodeCp437(decodeCp437(ALL_BYTES)), ALL_BYTES);
});

test("decodes German umlauts", () => {
  assert.equal(decodeCp437(Uint8Array.of(0x84, 0x94, 0x81, 0xe1)), "äöüß");
});

test("rejects characters outside the code page", () => {
  assert.throws(() => encodeCp437("€"), RangeError);
});
