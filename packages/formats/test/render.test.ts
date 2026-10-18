import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { episodePalette } from "../src/palette.ts";
import { parsePe } from "../src/pe.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH, renderRoom, toRgba } from "../src/render.ts";
import { cryptScene } from "../src/scene-crypt.ts";
import { parseScene } from "../src/scene.ts";
import { parseShapes } from "../src/shapes.ts";
import { exe, golden, goldenJson, resource } from "./data.ts";

function loadEpisode(episode: number) {
  const objects = parseShapes(resource("SHAPES", `1${episode}02`)).get("_Rob_object");
  assert.ok(objects);
  const rooms = parseScene(cryptScene(resource("SCENE", `1${episode}04`)));
  return { objects, rooms };
}

for (let episode = 0; episode < 5; episode++) {
  test(`episode ${episode}: every room renders like the Python renderer`, () => {
    const { objects, rooms } = loadEpisode(episode);
    const expected = goldenJson(`render/${episode}.json`) as Record<string, string>;
    assert.equal(rooms.length, Object.keys(expected).length);
    for (const room of rooms) {
      const hash = createHash("sha256").update(renderRoom(room, objects)).digest("hex");
      assert.equal(hash, expected[String(room.id)], `room ${room.id}`);
    }
  });
}

test("episode 1 room 43 matches the reference render pixel for pixel", () => {
  const { objects, rooms } = loadEpisode(1);
  const room = rooms.find((r) => r.id === 43);
  assert.ok(room);
  const pixels = renderRoom(room, objects);
  assert.equal(pixels.length, SCREEN_WIDTH * SCREEN_HEIGHT);
  assert.deepEqual(pixels, golden("render/1-43.bin"));
});

test("toRgba maps indices through the palette", () => {
  const palette = episodePalette(parsePe(exe()), 1);
  const rgba = toRgba(Uint8Array.of(0, 15, 9), palette);
  assert.deepEqual([...rgba], [0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255]);
});
