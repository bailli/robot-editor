import assert from "node:assert/strict";
import { test } from "node:test";

import { cryptScene } from "../src/scene-crypt.ts";
import { LOGIC_CELL, SceneFormatError, parseRoomMap, parseScene } from "../src/scene.ts";
import { assertBytesEqual, golden, goldenJson, hex, resources } from "./data.ts";

interface GoldenRoom {
  id: number;
  tags: { kind: number; value: number; data?: string }[];
  base: number[];
  over: number[];
  objects: { slot: number; data: string; extra?: number }[];
}

const all = resources("SCENE");

test("finds all 5 SCENE resources", () => {
  assert.equal(all.length, 5);
});

for (const { id, data } of all) {
  test(`SCENE ${id} decrypts like the Python tool`, () => {
    const plain = cryptScene(data);
    assertBytesEqual(plain, golden(`scene/${id}.scn`), `SCENE ${id}`);
    assert.equal(new TextDecoder().decode(plain.subarray(0, 5)), "SCNV3");
  });

  test(`SCENE ${id} rooms match the Python parser`, () => {
    const rooms = parseScene(cryptScene(data));
    const expected = goldenJson(`scene/${id}.rooms.json`) as GoldenRoom[];
    assert.equal(rooms.length, expected.length);
    rooms.forEach((room, i) => {
      const want = expected[i];
      assert.ok(want);
      assert.equal(room.id, want.id);
      assert.deepEqual(
        room.tags.map((t) => ({
          kind: t.kind,
          value: t.value,
          ...(t.data ? { data: hex(t.data) } : {}),
        })),
        want.tags,
      );
      assert.deepEqual(Array.from(room.base), want.base);
      assert.deepEqual(Array.from(room.overlay), want.over);
      assert.deepEqual(
        room.records.map((r) => ({
          slot: r.slot,
          data: hex(r.data),
          ...(r.extra === undefined ? {} : { extra: r.extra }),
        })),
        want.objects,
      );
    });
  });

  test(`SCENE ${id}: every logic record is placed by exactly the cells that reference it`, () => {
    for (const room of parseScene(cryptScene(data))) {
      const referenced = new Set<number>();
      for (const layer of [room.base, room.overlay]) {
        for (const cell of layer) {
          if ((cell & 0xff) === LOGIC_CELL) referenced.add(cell >> 8);
        }
      }
      assert.deepEqual(
        [...referenced].sort((a, b) => a - b),
        room.records.map((r) => r.slot).sort((a, b) => a - b),
        `room ${room.id}`,
      );
    }
  });
}

test("no original room has bytes after its logic records", () => {
  // The game reports a decode error for such rooms, so the shipped data must have none.
  for (const { id, data } of all) {
    for (const room of parseScene(cryptScene(data))) {
      assert.equal(room.trailing.length, 0, `SCENE ${id} room ${room.id}`);
    }
  }
});

test("rejects data without the SCNV3 signature", () => {
  const encrypted = all[0]?.data;
  assert.ok(encrypted);
  assert.throws(() => parseScene(encrypted), SceneFormatError);
});

test("rejects a truncated scene", () => {
  const plain = cryptScene(all[0]?.data ?? new Uint8Array());
  assert.throws(() => parseScene(plain.subarray(0, plain.length - 5)), SceneFormatError);
});

/** A map body whose four layers are all zero (one run of 1160 cells each). */
const EMPTY_LAYERS = Array.from({ length: 4 }, () => [
  ...Array<number>(9).fill(0xff),
  0x91,
  0x00,
]).flat();

test("keeps bytes after the last logic record instead of rejecting the room", () => {
  const record = [5, 0x05, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const map = parseRoomMap(Uint8Array.from([...EMPTY_LAYERS, ...record, 1, 2, 3]));
  assert.equal(map.records.length, 1);
  assert.deepEqual([...map.trailing], [1, 2, 3]);
});

test("a truncated actor record is left over, a complete one is parsed", () => {
  const truncated = [0xfe, ...Array<number>(12).fill(7)]; // needs 15 bytes, has 13
  const partial = parseRoomMap(Uint8Array.from([...EMPTY_LAYERS, ...truncated]));
  assert.deepEqual(partial.records, []);
  assert.equal(partial.trailing.length, 13);

  const actor = [0xfe, 0x78, 0x56, 0x34, 0x12, ...Array<number>(10).fill(1)];
  const full = parseRoomMap(Uint8Array.from([...EMPTY_LAYERS, ...actor]));
  assert.equal(full.records.length, 1);
  assert.equal(full.records[0]?.slot, 0xff);
  assert.equal(full.records[0]?.extra, 0x12345678);
  assert.equal(full.trailing.length, 0);
});

const SIGNATURE = [0x53, 0x43, 0x4e, 0x56, 0x33, 0x1a, 0x00];

/** A scene with one room (id 1, no tags) whose map is EMPTY_LAYERS, plus `extra` bytes. */
function scene(mapLength = EMPTY_LAYERS.length + 2, extra: number[] = []): Uint8Array {
  return Uint8Array.from([
    ...SIGNATURE,
    1,
    0,
    mapLength & 0xff,
    mapLength >> 8,
    ...EMPTY_LAYERS,
    ...extra,
  ]);
}

test("parses a minimal synthetic scene", () => {
  const rooms = parseScene(scene());
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0]?.id, 1);
});

test("rejects a map length below 2 and a stray byte after the last room", () => {
  assert.throws(() => parseScene(scene(1)), SceneFormatError);
  assert.throws(() => parseScene(scene(undefined, [0x42])), SceneFormatError);
});
