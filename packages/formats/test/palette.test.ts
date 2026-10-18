import assert from "node:assert/strict";
import { test } from "node:test";

import { episodePalette } from "../src/palette.ts";
import { PeFormatError, parsePe, readVa } from "../src/pe.ts";
import { exe, goldenJson } from "./data.ts";

const image = parsePe(exe());

test("parses the sections of GameOfRobot.exe", () => {
  assert.equal(image.imageBase, 0x400000);
  assert.deepEqual(
    image.sections.map((s) => s.name),
    [".text", ".rdata", ".data", ".rsrc"],
  );
});

test("palettes of all episodes match the Python tool", () => {
  const expected = goldenJson("palettes.json") as Record<string, number[][]>;
  for (let episode = 0; episode < 5; episode++) {
    assert.deepEqual(
      episodePalette(image, episode),
      expected[String(episode)],
      `episode ${episode}`,
    );
  }
});

test("episode 3 has its own palette", () => {
  assert.notDeepEqual(episodePalette(image, 3), episodePalette(image, 1));
  assert.deepEqual(episodePalette(image, 0), episodePalette(image, 1));
});

test("rejects reads outside initialised data", () => {
  assert.throws(() => readVa(image, 0x51bbdc, 25), PeFormatError);
});

test("rejects data that is not a PE image", () => {
  assert.throws(() => parsePe(new Uint8Array(100)), PeFormatError);
});
