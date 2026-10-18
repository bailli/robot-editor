import assert from "node:assert/strict";
import { test } from "node:test";

import { cryptScene } from "../src/scene-crypt.ts";
import { LOGIC_CELL, ROOM_CELLS, SceneFormatError, parseScene } from "../src/scene.ts";
import { golden, goldenJson, hex, resources } from "./data.ts";

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
    assert.deepEqual(cryptScene(data), golden(`scene/${id}.scn`));
  });

  test(`SCENE ${id} encryption round-trips`, () => {
    assert.deepEqual(cryptScene(cryptScene(data)), data);
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

test("every room has a full grid", () => {
  const rooms = all.flatMap(({ data }) => parseScene(cryptScene(data)));
  assert.equal(rooms.length, 346);
  for (const room of rooms) {
    assert.equal(room.base.length, ROOM_CELLS);
    assert.equal(room.overlay.length, ROOM_CELLS);
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
