import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test } from "vitest";

import { SCREEN_HEIGHT, SCREEN_WIDTH } from "@robot/formats";

import { readIndexedPng, writeIndexedPng } from "../src/png.ts";
import { differingCells, paletteOffset } from "../src/shots.ts";

test("indexed PNGs round-trip, with zoom", () => {
  const dir = mkdtempSync(join(tmpdir(), "robot-"));
  try {
    const image = {
      width: 3,
      height: 2,
      indices: Uint8Array.of(0, 1, 2, 2, 1, 0),
      palette: [
        [0, 0, 0],
        [255, 0, 0],
        [0, 0, 255],
      ] as const,
    };
    writeIndexedPng(join(dir, "a.png"), image);
    const back = readIndexedPng(join(dir, "a.png"));
    assert.deepEqual([...back.indices], [...image.indices]);
    assert.deepEqual(back.palette, image.palette);
    writeIndexedPng(join(dir, "b.png"), image, 2);
    const big = readIndexedPng(join(dir, "b.png"));
    assert.deepEqual([big.width, big.height], [6, 4]);
    assert.deepEqual([...big.indices.subarray(0, 6)], [0, 0, 1, 1, 2, 2]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("screenshots are compared by the low 4 bits, without the status row", () => {
  const ours = new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT).fill(15);
  const game = ours.map((c) => c + 176); // a dark room: same colours, other palette group
  assert.deepEqual(differingCells(game, ours), []);
  assert.equal(paletteOffset(game), 176);
  game[0] = 3; // status row: ignored
  game[13 * SCREEN_WIDTH + 2 * 16] = 4; // cell (2, 1)
  assert.deepEqual(differingCells(game, ours), [[2, 1]]);
});
