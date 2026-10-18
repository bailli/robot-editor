import assert from "node:assert/strict";
import { test } from "node:test";

import { episodePalette } from "../src/palette.ts";
import { PeFormatError, parsePe, readVa } from "../src/pe.ts";
import { exe, snapshots } from "./data.ts";

const snapshot = snapshots(import.meta.url);

const image = parsePe(exe());

test("parses the sections of GameOfRobot.exe", () => {
  assert.equal(image.imageBase, 0x400000);
  assert.deepEqual(
    image.sections.map((s) => s.name),
    [".text", ".rdata", ".data", ".rsrc"],
  );
});

test("palettes of all episodes", () => {
  for (let episode = 0; episode < 5; episode++) {
    snapshot(`episode ${episode}`, episodePalette(image, episode));
  }
});

test("rejects reads outside initialised data, also across a section's end", () => {
  const data = image.sections.find((s) => s.name === ".data");
  assert.ok(data);
  const end = image.imageBase + data.virtualAddress + data.rawSize;
  assert.equal(readVa(image, end - 16, 16).length, 16);
  assert.throws(() => readVa(image, end - 16, 32), PeFormatError);
  assert.throws(() => readVa(image, 0x51bbdc, 25), PeFormatError); // uninitialised data
});

test("rejects data that is not a PE image", () => {
  assert.throws(() => parsePe(new Uint8Array(100)), PeFormatError);
});

test("a truncated exe fails loudly instead of returning short data", () => {
  const truncated = parsePe(exe().subarray(0, 0x80000));
  assert.throws(() => episodePalette(truncated, 1), PeFormatError);
});
