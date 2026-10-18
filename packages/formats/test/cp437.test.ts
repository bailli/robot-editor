import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeCp437, encodeCp437 } from "../src/cp437.ts";
import { snapshots } from "./data.ts";

const snapshot = snapshots(import.meta.url);

const ALL_BYTES = Uint8Array.from({ length: 256 }, (_, i) => i);

test("decodes all 256 bytes", () => {
  assert.equal(decodeCp437(Uint8Array.of(0x41, 0x84, 0x94, 0x81, 0xe1, 0xb3, 0xfd)), "Aäöüß│²");
  snapshot("all 256 bytes", decodeCp437(ALL_BYTES));
});

test("round-trips all 256 bytes", () => {
  assert.deepEqual(encodeCp437(decodeCp437(ALL_BYTES)), ALL_BYTES);
});

test("rejects characters outside the code page", () => {
  assert.throws(() => encodeCp437("€"), RangeError);
});
