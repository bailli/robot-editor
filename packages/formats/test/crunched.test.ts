import assert from "node:assert/strict";

import { expect, test } from "vitest";

import { decodeCp437 } from "../src/cp437.ts";
import {
  CrunchedFormatError,
  SYMBOL_TABLE_SIZE,
  countEntries,
  crunch,
  uncrunch,
} from "../src/crunched.ts";
import { resources, snapshot } from "./data.ts";

const all = resources("CRUNCHED");

test("finds all 15 CRUNCHED resources", () => {
  assert.equal(all.length, 15);
});

for (const { id, data } of all) {
  test(`CRUNCHED ${id} decodes completely to printable text`, () => {
    const result = uncrunch(data);
    assert.equal(result.text.length, result.size); // the stream decodes completely
    const invalid = result.text.findIndex((b) => b !== 0x0a && (b < 0x20 || b === 0x7f));
    assert.equal(invalid, -1, `control byte at ${invalid}`);
    snapshot(`${id} header`, {
      marker: result.marker,
      size: result.size,
      entries: result.entryCount,
    });
    snapshot(`${id} text`, result.text);
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

/** The game's decoder (0x4314b0): stops when at most 8 bits are left. */
function gameDecode(data: Uint8Array): number[] {
  const table = data.subarray(0, SYMBOL_TABLE_SIZE);
  let pos = SYMBOL_TABLE_SIZE + 6;
  let buf = 0;
  let count = 0;
  const take = (n: number) => {
    const v = buf & ((1 << n) - 1);
    buf >>>= n;
    count -= n;
    return v;
  };
  const out: number[] = [];
  for (;;) {
    while (count <= 8 && pos < data.length) {
      buf |= data[pos++] << count;
      count += 8;
    }
    if (count <= 8) return out;
    let s: number;
    if (take(1) === 0) {
      const v = take(2);
      s = v !== 0 ? table[v - 1] : table[26 + take(6)];
    } else {
      const long = take(1) === 1;
      const v = take(long ? 4 : 3);
      if (long && v === 0 && count <= 8 && pos < data.length) {
        buf |= data[pos++] << count;
        count += 8;
      }
      s = !long ? table[3 + v] : v !== 0 ? table[10 + v] : take(8);
    }
    out.push(s === 0x7f ? 0x0a : s);
  }
}

test("crunch compresses the texts as well as the originals, and the game reads them back", () => {
  for (const { id, data } of all) {
    const original = uncrunch(data);
    const packed = crunch(original.text, original.entryCount);
    const unpacked = uncrunch(packed);
    expect(decodeCp437(unpacked.text).trimEnd(), id).toBe(decodeCp437(original.text).trimEnd());
    expect(unpacked.entryCount).toBe(original.entryCount);
    // the same code lengths; at most a few line feeds more at the end
    expect(packed.length - data.length, id).toBeGreaterThanOrEqual(0);
    expect(packed.length - data.length, id).toBeLessThanOrEqual(2);
    const read = gameDecode(packed);
    expect(read.slice(0, original.size), id).toEqual([...original.text]);
    expect(
      read.slice(original.size).every((b) => b === 0x0a),
      id,
    ).toBe(true);
  }
});

test("the texts' entry counts are their header lines", () => {
  for (const { id, data } of all.filter((r) => !r.id.endsWith("06"))) {
    const { text, entryCount } = uncrunch(data);
    expect(countEntries(text), id).toBe(entryCount);
  }
  // literals, a short text, an empty one
  for (const text of ["", "a", "1:\näx;\n", "x".repeat(300) + "ÿ"]) {
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    expect([...gameDecode(crunch(bytes))].slice(0, bytes.length)).toEqual([...bytes]);
  }
  assert.throws(() => crunch(Uint8Array.of(0x7f)), CrunchedFormatError);
});
