import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  cryptScene,
  findResource,
  parsePe,
  parseScene,
  readResources,
} from "@robot/formats";

import { loadGame } from "../src/game.ts";
import { START_ROOMS, patchedExe } from "../src/patch.ts";
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

test("a patched exe starts the episode in a copy of the wanted room without scripts", () => {
  const game = loadGame();
  const patched = parsePe(patchedExe(game, 1, 21));
  assert.equal(patched.data.length, game.image.data.length);
  const scene = findResource(readResources(patched), "SCENE", 1104);
  assert.ok(scene);
  const rooms = parseScene(cryptScene(scene.data));
  assert.deepEqual(
    rooms.map((r) => r.id),
    [1, 2, START_ROOMS[1]],
  );
  const start = rooms[2];
  const original = game.room(1, 21);
  assert.ok(start);
  assert.deepEqual(start.base, original.base);
  assert.deepEqual(start.records, original.records);
  assert.ok(!start.tags.some((t) => t.kind === 6 && (t.value === 1 || t.value === 2)));
});
