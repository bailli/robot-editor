import assert from "node:assert/strict";

import { expect, test } from "vitest";

import { darkPalette, darknessBlock, episodePalette } from "../src/palette.ts";
import { PeFormatError, parsePe, readVa } from "../src/pe.ts";
import { exe, snapshot } from "./data.ts";

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

test("darkness picks the palette block the game draws the room with", () => {
  expect([0, 40, 60, 80, 100, 200, 255].map(darknessBlock)).toEqual([0, 7, 9, 11, 12, 12, 0]);
});

test("dark palette blocks are those of the game's screenshots", () => {
  const palette = episodePalette(parsePe(exe()), 1);
  // episode I room 43 at darkness 60 (block 9) and its palette's block 4, from the game
  expect(darkPalette(palette, 4).map((c) => c.join(","))).toEqual(
    "0,0,0 61,61,61 2,2,48 66,66,163 5,5,101 21,117,117 130,177,34 26,168,72 174,128,32 158,16,16 106,10,10 112,16,112 128,128,128 18,114,64 182,182,40 190,190,190".split(
      " ",
    ),
  );
  expect(darkPalette(palette, 9).map((c) => c.join(","))).toEqual(
    "0,0,0 13,13,13 1,1,4 17,17,22 3,3,8 15,20,20 29,32,25 19,26,21 30,28,23 18,11,11 12,7,7 16,11,16 28,28,28 13,18,15 36,36,29 42,42,42".split(
      " ",
    ),
  );
  expect(darkPalette(palette, 3)).toEqual(palette);
  expect(darkPalette(palette, 12).every((c) => c.every((v) => v === 0))).toBe(true);
});
