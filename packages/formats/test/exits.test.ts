import assert from "node:assert/strict";

import { expect, test } from "vitest";

import {
  DIRECTIONS,
  EXIT_CELL,
  OUTSIDE_ROOM,
  arrivalCell,
  edgeCells,
  roomExits,
  roomScript,
  roomScriptExits,
  roomStairs,
  roomTeleports,
} from "../src/exits.ts";
import { EPISODES, Game, START_ROOMS } from "../src/game.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("the exits byte gives grid neighbours, room 2 or nothing", () => {
  const ids = new Set(game.episode(1).rooms.map((r) => r.id));
  // exits byte 0x20: west closed (opened by its script at a high score)
  assert.deepEqual(roomExits(game.room(1, 43), ids), { north: 33, south: 53, west: 0, east: 44 });
  // episode III: the island's edges lead to the sea, room 2, which leads to itself
  const ids3 = new Set(game.episode(3).rooms.map((r) => r.id));
  assert.equal(roomExits(game.room(3, 11), ids3).north, OUTSIDE_ROOM);
  assert.deepEqual(roomExits(game.room(3, 2), ids3), { north: 2, south: 2, west: 2, east: 2 });
});

for (const episode of EPISODES) {
  test(`episode ${episode}: exits of every room`, () => {
    const rooms = game.episode(episode).rooms;
    const ids = new Set(rooms.map((r) => r.id));
    // readable on purpose: room -> north south west east
    expect(
      rooms.map((r) => `${r.id} -> ${Object.values(roomExits(r, ids)).join(" ")}`),
    ).toMatchSnapshot();
  });
}

/**
 * Exits whose cells do not all arrive on exit cells of the target room (one-way passages
 * or level quirks), and the one exit no script opens.
 */
const KNOWN = [
  "0 51 east -> 52: 2/3",
  "0 52 north -> 42: 5/16",
  "1 21 south -> 31: 1/5",
  "1 34 west -> 33: 1/7",
  "1 73 west: never opened",
  "2 104 east -> 105: 4/4",
  "2 105 west -> 104: 1/1",
  "2 132 east -> 133: 1/1",
  "4 226 north -> 216: 1/1",
  "4 344 west -> 343: 1/1",
  "4 344 east -> 345: 1/1",
];

test("exit cells lead to exit cells of the room their exit or script names", () => {
  const found: string[] = [];
  let checked = 0;
  for (const episode of EPISODES) {
    const rooms = game.episode(episode).rooms;
    const ids = new Set(rooms.map((r) => r.id));
    for (const room of rooms) {
      const exits = roomExits(room, ids);
      const scripted = roomScriptExits(roomScript(room)).exits;
      for (const direction of DIRECTIONS) {
        const cells = edgeCells(direction).filter((c) => room.base[c] === EXIT_CELL);
        if (cells.length === 0) continue;
        const targets = new Set([
          exits[direction],
          ...scripted.filter((s) => s.direction === direction).map((s) => s.room),
        ]);
        targets.delete(0);
        if (targets.size === 0) found.push(`${episode} ${room.id} ${direction}: never opened`);
        for (const id of targets) {
          assert.ok(ids.has(id), `${episode} ${room.id} ${direction} -> missing room ${id}`);
          const target = rooms.find((r) => r.id === id);
          if (!target || id === OUTSIDE_ROOM) continue;
          const bad = cells.filter((c) => target.base[arrivalCell(c, direction)] !== EXIT_CELL);
          checked += cells.length;
          if (bad.length > 0) {
            found.push(
              `${episode} ${room.id} ${direction} -> ${id}: ${bad.length}/${cells.length}`,
            );
          }
        }
      }
    }
  }
  assert.ok(checked > 700, `only ${checked} exit cells checked`);
  assert.deepEqual(found, KNOWN);
});

test("scripts change exits and teleport, fixed or depending on the game state", () => {
  const source = [
    "RoomNorth = 674;",
    "if(!Possess(O_SUIT))",
    "   RoomEast = 22;",
    "RoomWest = 0;",
    "if(Score > 5) { Message(1, 2); RoomSouth = 3; }",
    "else Teleport(11, 20, 15);",
  ].join("\n");
  assert.deepEqual(roomScriptExits(source), {
    exits: [
      { direction: "north", room: 674, conditional: false },
      { direction: "east", room: 22, conditional: true },
      { direction: "west", room: 0, conditional: false },
      { direction: "south", room: 3, conditional: true },
    ],
    teleports: [{ room: 11, x: 20, y: 15, conditional: true }],
  });
});

test("the maze of episode II wires its edges by script", () => {
  const { exits } = roomScriptExits(roomScript(game.room(2, 624)));
  assert.deepEqual(exits, [
    { direction: "north", room: 674, conditional: false },
    { direction: "east", room: 631, conditional: false },
  ]);
});

test("stairs lead 100 rooms up or down onto the matching stairs", () => {
  const listed: string[] = [];
  for (const episode of EPISODES) {
    const { rooms, classes } = game.episode(episode);
    const ids = new Set(rooms.map((r) => r.id));
    for (const room of rooms) {
      for (const s of roomStairs(room, classes, ids)) {
        const where = `${episode} ${room.id} (${s.cell % 40},${Math.floor(s.cell / 40)}) ${s.direction}`;
        listed.push(`${where} -> ${s.room}`);
        if (room.id === OUTSIDE_ROOM) continue; // episode IV's unused tile sheet
        const target = rooms.find((r) => r.id === s.room);
        assert.ok(target, `${where}: no room ${room.id} ${s.direction === "up" ? "+" : "-"} 100`);
        // the matching stairs, at the same place (double stairs: the neighbouring cells)
        const back = roomStairs(target, classes, ids).filter(
          (t) =>
            t.direction !== s.direction &&
            Math.abs((t.cell % 40) - (s.cell % 40)) <= 1 &&
            Math.abs(Math.floor(t.cell / 40) - Math.floor(s.cell / 40)) <= 3,
        );
        assert.ok(back.length > 0, `${where}: no stairs back in room ${s.room}`);
      }
    }
  }
  expect(listed).toMatchSnapshot();
});

test("passages and teleporters lead to rooms of their episode", () => {
  const listed: string[] = [];
  for (const episode of EPISODES) {
    const rooms = game.episode(episode).rooms;
    const ids = new Set(rooms.map((r) => r.id));
    for (const room of rooms) {
      for (const t of roomTeleports(room)) {
        const at = t.cell === undefined ? "-" : `(${t.cell % 40},${Math.floor(t.cell / 40)})`;
        const line = `${episode} ${room.id} ${at} ${t.kind} -> ${t.room} (${t.x},${t.y})`;
        listed.push(line + (t.returns ? " returns" : ""));
        assert.ok(ids.has(t.room), `${line}: no such room`);
        assert.ok(t.x < 40 && t.y < 29, `${line}: outside the room`);
      }
    }
  }
  expect(listed).toMatchSnapshot();
});

/**
 * Rooms not reached from the start room through exits, scripts, stairs, passages and
 * teleporters. Room 99 of every episode is a debug room; the others still lack a
 * decoded connection.
 */
test("rooms reached from the start room", () => {
  const unreached = EPISODES.map((episode) => {
    const { rooms, classes } = game.episode(episode);
    const ids = new Set(rooms.map((r) => r.id));
    const next = (room: (typeof rooms)[number]) => {
      const script = roomScriptExits(roomScript(room));
      return [
        ...Object.values(roomExits(room, ids)),
        ...script.exits.map((s) => s.room),
        ...script.teleports.map((t) => t.room),
        ...roomStairs(room, classes, ids).map((s) => s.room),
        ...roomTeleports(room).map((t) => t.room),
      ];
    };
    const start = START_ROOMS[episode] ?? 0;
    const seen = new Set([start]);
    for (const id of seen) {
      const room = rooms.find((r) => r.id === id);
      if (room) for (const n of next(room)) if (ids.has(n)) seen.add(n);
    }
    // rooms 1 and 2: title screen and "outside"
    return `${episode}: ${[...ids].filter((id) => !seen.has(id) && id > 2).join(" ")}`;
  });
  expect(unreached).toMatchSnapshot();
});
