import assert from "node:assert/strict";

import { test } from "vitest";

import { CLASS_NEEDS, CODE_LOOKUP_CLASSES, TYPE_OF_CLASS_TABLE } from "../src/class-links.ts";
import { readEpisodeClasses } from "../src/classes.ts";
import { parsePe, readVa } from "../src/pe.ts";
import { exe } from "./data.ts";

const image = parsePe(exe());

/** The addresses in the code that load a fixed entry of the class → type table. */
function tableLookups(): Map<number, number[]> {
  const text = image.sections.find((s) => s.name === ".text");
  assert.ok(text);
  const start = image.imageBase + text.virtualAddress;
  const code = readVa(image, start, text.rawSize);
  const found = new Map<number, number[]>();
  const view = new DataView(code.buffer, code.byteOffset, code.length);
  for (let at = 0; at + 4 <= code.length; at++) {
    const value = view.getUint32(at, true);
    const id = (value - TYPE_OF_CLASS_TABLE) / 4;
    // class 0 is read through an index; the table's end (0x4c74a0) bounds a loop
    if (!Number.isInteger(id) || id < 1 || id >= 0xf0) continue;
    // a load: mov eax, [moffs32] (a1) or mov r32, [disp32] (8b, ModRM mod 0, r/m 5)
    const load =
      code[at - 1] === 0xa1 || (code[at - 2] === 0x8b && ((code[at - 1] ?? 0) & 0xc7) === 5);
    if (!load) continue;
    found.set(id, [...(found.get(id) ?? []), start + at]);
  }
  return found;
}

test("CODE_LOOKUP_CLASSES are the fixed entries of the class → type table the code reads", () => {
  const found = tableLookups();
  assert.deepEqual(
    [...found.keys()].sort((a, b) => a - b),
    [...CODE_LOOKUP_CLASSES.keys()],
  );
  for (const [id, addresses] of CODE_LOOKUP_CLASSES) {
    // each listed instruction holds the entry's address within its first bytes
    const near = found.get(id) ?? [];
    for (const va of addresses)
      assert.ok(
        near.some((at) => at > va && at - va <= 3),
        `${id} ${va}`,
      );
  }
});

test("CLASS_NEEDS name classes some episode has", () => {
  const ids = new Set(
    [0, 1, 2, 3, 4].flatMap((e) => [...readEpisodeClasses(image, e).typeOfClass.keys()]),
  );
  for (const n of CLASS_NEEDS) {
    assert.ok(ids.has(n.by), `${n.by} (${n.how})`);
    assert.ok(ids.has(n.needs), `${n.needs} (${n.how})`);
  }
});
