import assert from "node:assert/strict";

import { test } from "vitest";

import {
  START_ROOMS,
  cryptScene,
  findResource,
  parsePe,
  parseScene,
  readResources,
} from "@robot/formats";

import { loadGame } from "../src/game.ts";
import { patchedExe } from "../src/patch.ts";

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
