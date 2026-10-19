import type { EpisodeClasses } from "./classes.ts";
import { decodeCp437 } from "./cp437.ts";
import { LOGIC_CELL, ROOM_HEIGHT, ROOM_WIDTH, type Room } from "./scene.ts";

/**
 * Room connections (GameOfRobot.exe).
 *
 * Room ids lay the rooms out on a grid: north/south are id -/+ 10, west/east id -/+ 1.
 * On entering a room the game sets RoomNorth, RoomSouth, RoomWest and RoomEast
 * (0x4fe35e..0x4fe364) from the room's exits byte, the value of its kind 1 tag, with two
 * bits per direction (0x439590): bits 0-1 north, 2-3 south, 4-5 west, 6-7 east, each
 *   0  the grid neighbour, if the episode has that room (else no exit)
 *   1  room 2, the episode's "outside" (episode III: the open sea)
 *   2  no exit (3 likewise)
 * Room scripts can then change the four variables (`RoomEast = 45;`, often depending on
 * score or items), move the hero with Teleport(room, x, y), or set where the bus goes
 * (BusWest, BusEast: the bus object takes the hero there, 0x44a831); see
 * roomScriptExits.
 *
 * The hero leaves a room by walking off the map (0x427a9b): onto the target's opposite
 * edge, in the same row or column. Rows 1 and 28 and columns 0 and 39 are the edges (row
 * 0 lies under the status line). Walled rooms mark their exits with cells 0x0017; the
 * game turns them into 0x0110 (closed) on edges without a target and back (0x433ae5).
 *
 * Passages lead to the room 100 "further in" (buildings, caves below) or back out:
 *   door in   class 98 (tile 0x53, episodes II-IV) with state 6, entered walking north,
 *             or 7, walking south: room + 100 (0x413d30), e.g. a hut's doorway
 *   door out  class 105 (tile 0x5a): room - 100 (0x4140d0)
 *   stairs    class 71 (tile 0x3d, episodes I-IV), steps into the ground: room + 100,
 *             or with state bit 0 set (steps up) room - 100 (0x426880)
 * The hero keeps the column and moves on in the walking direction (doors: two cells,
 * stairs: one); the other room has the matching door or stairs at the same place.
 *
 * Logic records move the hero to a target in their u16 at data offset 4 (room = bits
 * 0-9, x = bits 10-15) and y at offset 6:
 *   type 12  an oracle (0x412ae0): teleports the hero who walks north onto it; walked
 *            onto otherwise it gives a hint or an item, or kills
 *   type 13  a teleporter, taken when the hero steps onto its cell (0x44cc30); a non-zero
 *            byte at offset 8 shows message 0x4b0 + it, and with bit 1 of offset 1 set
 *            the hero returns to a point saved at run time instead, if there is one
 */

export const DIRECTIONS = ["north", "south", "west", "east"] as const;
export type Direction = (typeof DIRECTIONS)[number];
export type Exits = Record<Direction, number>;

/** Tag kind holding the exits byte. */
export const EXITS_TAG = 1;
export const OUTSIDE_ROOM = 2;
export const EXIT_CELL = 0x0017;
export const CLOSED_EXIT_CELL = 0x0110;

/** Class ids of passages to room +/- 100 (see above). */
export const DOOR_IN_CLASS = 98;
export const DOOR_OUT_CLASS = 105;
export const STAIRS_CLASS = 71;

export type PassageKind = "door in" | "door out" | "stairs down" | "stairs up";

export interface Passage {
  /** Cell index in the room. */
  cell: number;
  kind: PassageKind;
  /** Target room (room id +/- 100), 0 if the episode has no such room. */
  room: number;
}

/** The kind of passage that leads back. */
export const RETURN_PASSAGE: Readonly<Record<PassageKind, PassageKind>> = {
  "door in": "door out",
  "door out": "door in",
  "stairs down": "stairs up",
  "stairs up": "stairs down",
};

export const ORACLE_RECORD = 12;
export const TELEPORTER_RECORD = 13;

export interface RecordTeleport {
  /** The logic cell (base or overlay) that places the record, undefined if none does. */
  cell: number | undefined;
  kind: "oracle" | "teleporter";
  room: number;
  x: number;
  y: number;
  /** Teleporter that returns to a run-time point when there is one (flag 0x02). */
  returns: boolean;
}

const STEP: Readonly<Record<Direction, number>> = { north: -10, south: 10, west: -1, east: 1 };

export const OPPOSITE: Readonly<Record<Direction, Direction>> = {
  north: "south",
  south: "north",
  west: "east",
  east: "west",
};

export function exitsByte(room: Room): number {
  return room.tags.find((t) => t.kind === EXITS_TAG)?.value ?? 0;
}

/**
 * Where each direction leads on entering the room (0 = nowhere), before the room's
 * script runs. `ids` are the ids of the episode's rooms.
 */
export function roomExits(room: Room, ids: ReadonlySet<number>): Exits {
  const byte = exitsByte(room);
  const target = (direction: Direction, i: number) => {
    const mode = (byte >> (2 * i)) & 3;
    const neighbour = room.id + STEP[direction];
    return mode === 0 ? (ids.has(neighbour) ? neighbour : 0) : mode === 1 ? OUTSIDE_ROOM : 0;
  };
  return {
    north: target("north", 0),
    south: target("south", 1),
    west: target("west", 2),
    east: target("east", 3),
  };
}

function passageKind(classes: EpisodeClasses, value: number): PassageKind | undefined {
  const state = value >> 8;
  const id = classes.classes.get(value & 0xff)?.id;
  if (id === DOOR_IN_CLASS)
    return (state & 0xf) === 6 || (state & 0xf) === 7 ? "door in" : undefined;
  if (id === DOOR_OUT_CLASS) return "door out";
  if (id === STAIRS_CLASS) return state & 1 ? "stairs up" : "stairs down";
  return undefined;
}

/** The doors and stairs of a room (base and overlay cells). */
export function roomPassages(
  room: Room,
  classes: EpisodeClasses,
  ids: ReadonlySet<number>,
): Passage[] {
  const passages: Passage[] = [];
  for (const layer of [room.base, room.overlay]) {
    layer.forEach((value, cell) => {
      const kind = passageKind(classes, value);
      if (!kind) return;
      const target = room.id + (kind === "door in" || kind === "stairs down" ? 100 : -100);
      passages.push({ cell, kind, room: ids.has(target) ? target : 0 });
    });
  }
  return passages;
}

/** The oracles and teleporters among a room's logic records (with a target room). */
export function roomTeleports(room: Room): RecordTeleport[] {
  const cellOf = (slot: number) => {
    for (const layer of [room.base, room.overlay]) {
      const cell = layer.findIndex((v) => (v & 0xff) === LOGIC_CELL && v >> 8 === slot);
      if (cell >= 0) return cell;
    }
    return undefined;
  };
  return room.records.flatMap((record) => {
    const [type = 0, flags = 0, , , low = 0, high = 0, y = 0] = record.data;
    const target = low | (high << 8);
    if ((type !== ORACLE_RECORD && type !== TELEPORTER_RECORD) || (target & 0x3ff) === 0) {
      return [];
    }
    return [
      {
        cell: cellOf(record.slot),
        kind: type === ORACLE_RECORD ? ("oracle" as const) : ("teleporter" as const),
        room: target & 0x3ff,
        x: target >> 10,
        y,
        returns: type === TELEPORTER_RECORD && (flags & 0x02) !== 0,
      },
    ];
  });
}

/** The cells of an edge, in order along it (west to east, north to south). */
export function edgeCells(direction: Direction): number[] {
  switch (direction) {
    case "north":
      return Array.from({ length: ROOM_WIDTH }, (_, x) => ROOM_WIDTH + x);
    case "south":
      return Array.from({ length: ROOM_WIDTH }, (_, x) => (ROOM_HEIGHT - 1) * ROOM_WIDTH + x);
    case "west":
      return Array.from({ length: ROOM_HEIGHT - 1 }, (_, y) => (y + 1) * ROOM_WIDTH);
    case "east":
      return Array.from(
        { length: ROOM_HEIGHT - 1 },
        (_, y) => (y + 1) * ROOM_WIDTH + ROOM_WIDTH - 1,
      );
  }
}

/** The cell where the hero arrives when leaving through `cell` towards `direction`. */
export function arrivalCell(cell: number, direction: Direction): number {
  const x = cell % ROOM_WIDTH;
  const y = Math.floor(cell / ROOM_WIDTH);
  switch (direction) {
    case "north":
      return (ROOM_HEIGHT - 1) * ROOM_WIDTH + x;
    case "south":
      return ROOM_WIDTH + x;
    case "west":
      return y * ROOM_WIDTH + ROOM_WIDTH - 1;
    case "east":
      return y * ROOM_WIDTH;
  }
}

/** A room's script source (tag 6/1), empty if it has none. */
export function roomScript(room: Room): string {
  const tag = room.tags.find((t) => t.kind === 6 && t.value === 1);
  return tag?.data ? decodeCp437(tag.data).replace(/\0.*$/s, "") : "";
}

export interface ScriptExit {
  direction: Direction;
  /** Target room, 0 = closed. */
  room: number;
  /** Whether the assignment is inside an if/else (so depends on the game state). */
  conditional: boolean;
}

export interface ScriptBus {
  direction: "west" | "east";
  room: number;
  conditional: boolean;
}

export interface ScriptTeleport {
  room: number;
  x: number;
  y: number;
  conditional: boolean;
}

const ASSIGNMENT = /\bRoom(North|South|West|East)\s*=\s*(\d+)\s*;/g;
const BUS = /\bBus(West|East)\s*=\s*(\d+)\s*;/g;
const TELEPORT = /\bTeleport\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g;

/**
 * Exit changes and teleports in a room's script source (tag 6/1, C-like). A statement is
 * conditional when it is the body of an `if (...)` or `else`, or inside braces (the
 * scripts use braces only for if/else bodies).
 */
export function roomScriptExits(source: string): {
  exits: ScriptExit[];
  teleports: ScriptTeleport[];
  buses: ScriptBus[];
} {
  const conditional = (index: number) => {
    const before = source.slice(0, index);
    const depth = (before.match(/\{/g)?.length ?? 0) - (before.match(/\}/g)?.length ?? 0);
    return depth > 0 || /(\)|\belse)\s*$/.test(before);
  };
  const exits = [...source.matchAll(ASSIGNMENT)].map((m) => ({
    direction: m[1].toLowerCase() as Direction,
    room: Number(m[2]),
    conditional: conditional(m.index),
  }));
  const buses = [...source.matchAll(BUS)].map((m) => ({
    direction: m[1].toLowerCase() as "west" | "east",
    room: Number(m[2]),
    conditional: conditional(m.index),
  }));
  const teleports = [...source.matchAll(TELEPORT)].map((m) => ({
    room: Number(m[1]),
    x: Number(m[2]),
    y: Number(m[3]),
    conditional: conditional(m.index),
  }));
  return { exits, teleports, buses };
}
