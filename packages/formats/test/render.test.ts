import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { episodePalette } from "../src/palette.ts";
import { parsePe } from "../src/pe.ts";
import { SCREEN_HEIGHT, SCREEN_WIDTH, cellFrame, renderRoom, toRgba } from "../src/render.ts";
import { cryptScene } from "../src/scene-crypt.ts";
import { LOGIC_CELL, ROOM_CELLS, type Room, parseScene } from "../src/scene.ts";
import { type Shape, type ShapeTable, parseShapes } from "../src/shapes.ts";
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

test("cellFrame takes the low nibble of the high byte, falling back to frame 0", () => {
  const { objects } = loadEpisode(1);
  const wall = objects[6];
  assert.ok(wall);
  assert.equal(wall.frames.length, 6);
  assert.equal(cellFrame(wall, 0x0006), 0);
  assert.equal(cellFrame(wall, 0x0206), 2); // diagonal corner piece
  assert.equal(cellFrame(wall, 0x1406), 4); // high nibble is not part of the frame
  assert.equal(cellFrame(wall, 0x0906), 0); // no frame 9
});

test("toRgba maps indices through the palette", () => {
  const palette = episodePalette(parsePe(exe()), 1);
  const rgba = toRgba(Uint8Array.of(0, 15, 9), palette);
  assert.deepEqual([...rgba], [0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 255]);
});

function room(cells: Record<number, number>): Room {
  const base = new Uint16Array(ROOM_CELLS);
  for (const [i, cell] of Object.entries(cells)) base[Number(i)] = cell;
  return {
    id: 1,
    tags: [],
    base,
    overlay: new Uint16Array(ROOM_CELLS),
    records: [],
    trailing: new Uint8Array(),
  };
}

const SOLID: Shape = {
  width: 16,
  height: 12,
  bytesPerRow: 2,
  colours: [6, 0, 0],
  unknown: 0,
  frames: [{ word: 0, planes: [new Uint8Array(24).fill(0xff), null, null, null] }],
};

test("logic cells are never drawn, even if the table has a shape 127", () => {
  const table: ShapeTable = Array.from({ length: 128 }, () => SOLID);
  const pixels = renderRoom(room({ 0: LOGIC_CELL, 1: 0x0001 }), table);
  assert.equal(pixels[0], 15); // cell 0: logic cell stays background
  assert.equal(pixels[16], 15 ^ 6); // cell 1: drawn
});

test("cells whose shape has no frames are skipped", () => {
  const empty: Shape = { ...SOLID, frames: [] };
  assert.equal(cellFrame(empty, 0x0001), undefined);
  const pixels = renderRoom(room({ 0: 0x0001 }), [null, empty]);
  assert.ok(pixels.every((c) => c === 15));
});
