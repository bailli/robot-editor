import assert from "node:assert/strict";

import { test } from "vitest";

import { readEpisodeClasses } from "../src/classes.ts";
import type { Rgb } from "../src/palette.ts";
import { parsePe } from "../src/pe.ts";
import {
  SCREEN_HEIGHT,
  SCREEN_WIDTH,
  backdropRoom,
  cellFrame,
  renderRoom,
  shownCells,
  toRgba,
} from "../src/render.ts";
import { cryptScene } from "../src/scene-crypt.ts";
import { LOGIC_CELL, ROOM_CELLS, type Room, parseScene } from "../src/scene.ts";
import { type Shape, type ShapeTable, parseShapes } from "../src/shapes.ts";
import { exe, resource, snapshot } from "./data.ts";

const image = parsePe(exe());

function loadEpisode(episode: number) {
  const objects = parseShapes(resource("SHAPES", `1${episode}02`)).get("_Rob_object");
  assert.ok(objects);
  const rooms = parseScene(cryptScene(resource("SCENE", `1${episode}04`)));
  return { objects, rooms, classes: readEpisodeClasses(image, episode) };
}

for (let episode = 0; episode < 5; episode++) {
  test(`episode ${episode}: renders of every room`, () => {
    const { objects, rooms, classes } = loadEpisode(episode);
    for (const room of rooms) {
      snapshot(`episode ${episode} room ${room.id}`, renderRoom(room, objects, classes));
    }
  });
}

test("teleporters with a condition: on colour 15 with the frame, or on black", () => {
  const { objects, rooms, classes } = loadEpisode(1);
  const room21 = rooms.find((r) => r.id === 21);
  assert.ok(room21);
  const at = (x: number, y: number) => y * 40 + x;
  // (1, 2) needs its object, (18, 14) forbids gold (both match the game's screenshot)
  assert.equal(shownCells(room21, at(1, 2), classes)[3], "carry");
  assert.deepEqual(shownCells(room21, at(18, 14), classes), [0x000a, 0, false, "not carry"]);
  const pixels = renderRoom(room21, objects, classes);
  const pixel = (x: number, y: number) => pixels[y * SCREEN_WIDTH + x];
  assert.equal(pixel(18 * 16, 14 * 12), 0); // black around the gold
  assert.equal(pixel(1 * 16, 2 * 12), 0); // the teleporter's frame, XORed onto colour 15
  // a forbidden GATE piece shows its frame by the record's slot instead (room 128)
  const room128 = rooms.find((r) => r.id === 128);
  assert.ok(room128);
  assert.deepEqual(shownCells(room128, at(37, 15), classes), [0x0042, 0, false, "not carry"]);
});

test("the room behind a room: id mod 100 in Junior to III, id - 100 in IV", () => {
  const behind = (episode: number) => {
    const { rooms, classes } = loadEpisode(episode);
    return (id: number) => {
      const room = rooms.find((r) => r.id === id);
      assert.ok(room);
      return backdropRoom(room, rooms, classes)?.id;
    };
  };
  const ii = behind(2);
  assert.equal(ii(242), 42); // not 142, which has room 42 behind it too
  assert.equal(ii(142), 42);
  assert.equal(ii(115), 15);
  assert.equal(behind(3)(147), 47);
  const iv = behind(4);
  assert.equal(iv(441), 341); // marked at (39, 1) only
  assert.equal(iv(272), 172);
  assert.equal(behind(1)(117), undefined); // episode I has no class 99 cells
});

test("cellFrame takes the low nibble of the high byte, falling back to frame 0", () => {
  const wall: Shape = { ...SOLID, frames: Array.from({ length: 6 }, () => SOLID.frames[0]) };
  assert.equal(cellFrame(wall, 0x0006), 0);
  assert.equal(cellFrame(wall, 0x0206), 2); // e.g. a diagonal wall corner piece
  assert.equal(cellFrame(wall, 0x1406), 4); // the high nibble is not part of the frame
  assert.equal(cellFrame(wall, 0x0906), 0); // no frame 9
});

test("toRgba maps indices through the palette, unknown indices to opaque black", () => {
  const palette: Rgb[] = [
    [1, 2, 3],
    [4, 5, 6],
  ];
  const rgba = toRgba(Uint8Array.of(1, 0, 200), palette);
  assert.deepEqual([...rgba], [4, 5, 6, 255, 1, 2, 3, 255, 0, 0, 0, 255]);
  assert.equal(
    toRgba(new Uint8Array(SCREEN_WIDTH * SCREEN_HEIGHT), palette).length,
    SCREEN_WIDTH * SCREEN_HEIGHT * 4,
  );
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
