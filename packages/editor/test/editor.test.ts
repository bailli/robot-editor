import { describe, expect, test } from "vitest";

import {
  Game,
  KITS,
  LOGIC_CELL,
  type Mod,
  NO_CHANGES,
  ORACLE_CLASS,
  ORACLE_VANISHES_EAST,
  ORACLE_VANISHES_NORTH,
  ROOM_CELLS,
  ROOM_WIDTH,
  applyMod,
  compileScript,
  describeRecord,
  emptyMod,
  findResource,
  kitChanges,
  modJson,
  movedRecord,
  parseMod,
  parsePe,
  planKit,
  readBackdropRule,
  readDealer,
  readDiagonalMoves,
  readEpisodeFlags,
  readEpisodeStart,
  readEventTable,
  readOracleSymbols,
  readRucksack,
  readVa,
  roomCircuit,
  roomCompiledScript,
  roomScript,
  roomSettings,
  serializeRoom,
  sha256,
  tangramTile,
} from "@robot/formats";

import {
  Editor,
  MAX_RECORD_SLOTS,
  areaCells,
  clipArea,
  fillRegion,
  recordCapacity,
  shownCell,
  tilesOf,
} from "../src/editor.ts";
import { defined, firstDifference, loadGame } from "./game.ts";

const game = await loadGame();
const room = game.room(1, 43);
const free = room.base.findIndex((c, i) => i > 40 && (c & 0xff) !== LOGIC_CELL);
const logic = room.base.findIndex((c) => (c & 0xff) === LOGIC_CELL);

function paint(editor: Editor, index: number, value: number, layer: "base" | "overlay" = "base") {
  editor.beginStroke(1, 43, layer);
  const changed = editor.paint(index, value);
  editor.endStroke();
  return changed;
}

describe("Editor", () => {
  test("paints a copy of the room and leaves the loaded game untouched", () => {
    const editor = new Editor(game);
    expect(paint(editor, free, 0x0105)).toBe(true);
    expect(editor.room(1, 43).base[free]).toBe(0x0105);
    expect(game.room(1, 43).base[free]).toBe(room.base[free]);
    expect(editor.isEdited(1, 43)).toBe(true);
    expect(editor.isEdited(1, 44)).toBe(false);
    expect(editor.dirty).toBe(true);
  });

  test("undo and redo work by stroke", () => {
    const editor = new Editor(game);
    editor.beginStroke(1, 43, "overlay");
    editor.paint(free, 0x0105);
    editor.paint(free + 1, 0x0105);
    editor.paint(free, 0x0205); // the same cell again within the stroke
    editor.endStroke();
    expect(editor.undo()?.changes).toEqual([
      { index: free, before: room.overlay[free], after: 0x0205 },
      { index: free + 1, before: room.overlay[free + 1], after: 0x0105 },
    ]);
    expect(editor.room(1, 43).overlay).toEqual(room.overlay);
    expect(editor.isEdited(1, 43)).toBe(false);
    expect(editor.dirty).toBe(false);
    editor.redo();
    expect(editor.room(1, 43).overlay[free]).toBe(0x0205);
    expect(editor.canRedo).toBe(false);
  });

  test("a new stroke after undo drops the redo history", () => {
    const editor = new Editor(game);
    paint(editor, free, 0x0105);
    editor.undo();
    paint(editor, free, 0x0305);
    expect(editor.canRedo).toBe(false);
    expect(editor.redo()).toBeUndefined();
  });

  test("logic cells can be neither painted over nor painted", () => {
    const editor = new Editor(game);
    expect(paint(editor, logic, 0x0105)).toBe(false);
    expect(paint(editor, free, LOGIC_CELL)).toBe(false);
    expect(editor.dirty).toBe(false);
  });

  test("painting a cell with its own value is no change", () => {
    const editor = new Editor(game);
    expect(paint(editor, free, room.base[free] ?? 0)).toBe(false);
    expect(editor.canUndo).toBe(false);
  });

  test("saving writes the edited episodes into a copy of the exe", () => {
    const editor = new Editor(game);
    paint(editor, free, 0x0105);
    editor.beginStroke(3, game.episode(3).rooms[5]?.id ?? 0, "overlay");
    editor.paint(100, 0x0001);
    editor.endStroke();
    const saved = new Game(editor.save());
    expect(editor.dirty).toBe(false);
    expect(saved.room(1, 43).base[free]).toBe(0x0105);
    expect(saved.episode(3).rooms[5]?.overlay[100]).toBe(0x0001);
    expect(saved.episode(2).rooms).toEqual(game.episode(2).rooms);
    editor.undo();
    expect(editor.dirty).toBe(true);
  });

  test("saving without edits gives the loaded exe", () => {
    expect(firstDifference(new Editor(game).save(), game.image.data)).toBe(-1);
  });
});

test("tilesOf lists the distinct values of a layer, empty first, without logic cells", () => {
  const tiles = tilesOf(game.episode(1).rooms, "base");
  expect(tiles[0]).toBe(0);
  expect(new Set(tiles).size).toBe(tiles.length);
  expect(tiles.some((t) => (t & 0xff) === LOGIC_CELL)).toBe(false);
  expect(tiles).toContain(room.base[free]);
  // cells only records hold: in the base palette (episode IV room 185's teleporter wall)
  expect(tilesOf(game.episode(4).rooms, "base")).toContain(0xd044);
  expect(tilesOf(game.episode(4).rooms, "overlay")).not.toContain(0xd044);
});

describe("Editor records", () => {
  const room55 = game.room(2, 55);
  const teleporterIndex = room55.base.findIndex((c) => (c & 0xff) === LOGIC_CELL);
  const teleporter = defined(
    room55.records.find((r) => r.slot === (room55.base[teleporterIndex] ?? 0) >> 8),
    "teleporter",
  );

  test("changing a record is one undo step and survives saving", () => {
    const editor = new Editor(game);
    const data = teleporter.data.slice();
    data[6] = 9; // arrival y
    expect(editor.setRecord(2, 55, teleporter.slot, data)).toBeDefined();
    expect(editor.isEdited(2, 55)).toBe(true);
    expect(game.room(2, 55).records.find((r) => r.slot === teleporter.slot)?.data[6]).not.toBe(9);
    const saved = new Game(editor.save());
    expect(saved.room(2, 55).records.find((r) => r.slot === teleporter.slot)?.data[6]).toBe(9);
    editor.undo();
    expect(editor.isEdited(2, 55)).toBe(false);
    expect(editor.setRecord(2, 55, teleporter.slot, teleporter.data)).toBeUndefined(); // no change
  });

  test("a new record shows the cell it replaces", () => {
    const editor = new Editor(game);
    const slot = defined(editor.addRecord(1, 43, "base", free, 13), "slot");
    const room = editor.room(1, 43);
    expect(room.base[free]).toBe(LOGIC_CELL | (slot << 8));
    const record = room.records.find((r) => r.slot === slot);
    expect(record?.data[0]).toBe(13);
    expect(shownCell(defined(record))).toBe(game.room(1, 43).base[free]);
    expect(editor.addRecord(1, 43, "base", free, 13)).toBeUndefined(); // a logic cell already
    editor.undo();
    expect(editor.room(1, 43).base[free]).toBe(game.room(1, 43).base[free]);
    expect(editor.room(1, 43).records).toEqual(game.room(1, 43).records);
  });

  test("removing a record leaves the cell it showed", () => {
    const editor = new Editor(game);
    editor.removeRecord(2, 55, "base", teleporterIndex);
    const room = editor.room(2, 55);
    expect(room.base[teleporterIndex]).toBe(shownCell(teleporter));
    expect(room.records.some((r) => r.slot === teleporter.slot)).toBe(false);
    editor.undo();
    expect(editor.room(2, 55).records).toEqual(room55.records);
  });

  test("new records take the lowest free slot below 200", () => {
    const editor = new Editor(game);
    const used = new Set(game.room(1, 43).records.map((r) => r.slot));
    const lowest = [...Array(MAX_RECORD_SLOTS).keys()].find((k) => !used.has(k));
    expect(editor.addRecord(1, 43, "base", free, 5)).toBe(lowest);
  });

  test("records go into the base layer, as many as the game's table holds", () => {
    const editor = new Editor(game);
    // the game drops logic cells in the overlay (tried in the game)
    expect(editor.addRecord(1, 43, "overlay", free, 13)).toBeUndefined();
    expect(recordCapacity(room)).toBe(
      MAX_RECORD_SLOTS - room.records.length - room.overlay.filter((c) => c !== 0).length,
    );
    editor.beginStroke(1, 43, "overlay");
    for (let i = 0; i < ROOM_CELLS && recordCapacity(editor.room(1, 43)) > 0; i++)
      editor.paint(i, 0x0015);
    editor.endStroke();
    expect(editor.addRecord(1, 43, "base", free, 13)).toBeUndefined();
  });
});

describe("Editor scripts", () => {
  test("a new script is one undo step, compiled into the room and saved", () => {
    const editor = new Editor(game);
    const source = "if (NewRoom)\n   Message(700, 25);\nRoomWest = 42;";
    expect(editor.setScript(1, 43, source)?.tags).toBeDefined();
    expect(roomScript(editor.room(1, 43))).toBe(source);
    expect(editor.isEdited(1, 43)).toBe(true);
    const saved = new Game(editor.save()).room(1, 43);
    expect(roomScript(saved)).toBe(source);
    expect(roomCompiledScript(saved)).toEqual(
      compileScript(source, { constants: game.scriptConstants(1) }),
    );
    editor.undo();
    expect(roomScript(editor.room(1, 43))).toBe(roomScript(room));
    expect(editor.isEdited(1, 43)).toBe(false);
  });

  test("a script that does not compile changes nothing", () => {
    const editor = new Editor(game);
    expect(() => editor.setScript(1, 43, "Mesage(1, 0);")).toThrow("unknown function Mesage");
    expect(editor.canUndo).toBe(false);
    // the same source is no change
    expect(editor.setScript(1, 43, roomScript(room))).toBeUndefined();
  });
});

describe("Editor areas", () => {
  // episode II room 55: a teleporter (a logic cell) to copy
  const room55 = game.room(2, 55);
  const logic55 = room55.base.findIndex((c) => (c & 0xff) === LOGIC_CELL);
  const at = { x: logic55 % 40, y: Math.floor(logic55 / 40) };
  const area = { x: at.x - 1, y: at.y - 1, w: 3, h: 3 };

  test("a copied area takes the records of its logic cells into another room", () => {
    const editor = new Editor(game);
    const clip = editor.copyArea(2, 55, area);
    expect([clip.w, clip.h, clip.records.length]).toEqual([3, 3, 1]);
    const before = editor.room(2, 43).records.length;
    expect(editor.pasteArea(2, 43, 10, 10, clip)?.changes.length).toBeGreaterThan(0);
    const room = editor.room(2, 43);
    expect(room.records.length).toBe(before + 1);
    const cell = room.base[11 * 40 + 11] ?? 0;
    expect(cell & 0xff).toBe(LOGIC_CELL);
    const record = defined(room.records.find((r) => r.slot === cell >> 8));
    expect(Array.from(record.data)).toEqual(Array.from(clip.records[0]?.data ?? []));
    expect(Array.from(room.overlay.subarray(10 * 40 + 10, 10 * 40 + 13))).toEqual(
      Array.from(clip.overlay.subarray(0, 3)),
    );
    // saved and undone as one step
    expect(new Game(editor.save()).room(2, 43).records.length).toBe(before + 1);
    editor.undo();
    expect(editor.isEdited(2, 43)).toBe(false);
  });

  test("clearing an area empties both layers and removes its records", () => {
    const editor = new Editor(game);
    editor.clearArea(2, 55, area);
    const room = editor.room(2, 55);
    for (const i of areaCells(area)) expect([room.base[i], room.overlay[i]]).toEqual([0, 0]);
    expect(room.records.length).toBe(room55.records.length - 1);
    editor.undo();
    expect(editor.isEdited(2, 55)).toBe(false);
    expect(editor.clearArea(2, 55, { x: 0, y: 0, w: 0, h: 0 })).toBeUndefined();
  });

  test("an area edit that changes nothing is no edit, also with records out of slot order", () => {
    const editor = new Editor(game);
    editor.clearArea(2, 55, area);
    const cleared = new Set(areaCells(area));
    const cell = room55.base.findIndex(
      (c, i) => i > 40 && !cleared.has(i) && (c & 0xff) !== LOGIC_CELL,
    );
    editor.addRecord(2, 55, "base", cell, 13); // the slot just freed, after higher ones
    const slots = editor.room(2, 55).records.map((r) => r.slot);
    expect(slots).not.toEqual(slots.toSorted((a, b) => a - b));
    expect(editor.clearArea(2, 55, area)).toBeUndefined();
    expect(editor.pasteArea(2, 55, area.x, area.y, editor.copyArea(2, 55, area))).toBeUndefined();
  });

  test("pasting where the cells came from changes nothing; pasting over records replaces them", () => {
    const editor = new Editor(game);
    const clip = editor.copyArea(2, 55, area);
    expect(editor.pasteArea(2, 55, area.x, area.y, clip)).toBeUndefined();
    // one cell to the right: the old record goes, the copy takes its slot
    editor.pasteArea(2, 55, area.x + 1, area.y, clip);
    const room = editor.room(2, 55);
    expect(room.records.length).toBe(room55.records.length);
    expect((room.base[logic55 + 1] ?? 0) & 0xff).toBe(LOGIC_CELL);
    expect((room.base[logic55] ?? 0) & 0xff).not.toBe(LOGIC_CELL);
  });

  test("areas are cut to the room, pastes too", () => {
    expect(clipArea({ x: 38, y: -2, w: 5, h: 4 })).toEqual({ x: 38, y: 0, w: 2, h: 2 });
    const editor = new Editor(game);
    const clip = editor.copyArea(1, 43, { x: 0, y: 0, w: 4, h: 4 });
    const edit = defined(editor.pasteArea(1, 44, 38, 27, clip));
    const corner = new Set(areaCells({ x: 38, y: 27, w: 2, h: 2 }));
    expect(edit.changes.length).toBeGreaterThan(0);
    expect(edit.changes.every((c) => corner.has(c.index))).toBe(true);
  });

  test("a paste the game's record table cannot hold is refused", () => {
    const editor = new Editor(game);
    const full = new Uint16Array(40 * 29).fill(0x0015); // an object in every overlay cell
    const clip = {
      episode: 1,
      w: 40,
      h: 29,
      base: new Uint16Array(40 * 29),
      overlay: full,
      records: [],
    };
    expect(() => editor.pasteArea(1, 43, 0, 0, clip)).toThrow(RangeError);
    expect(editor.canUndo).toBe(false);
  });

  test("a fill takes the connected cells of the same value, not logic cells", () => {
    const base = new Uint16Array(40 * 29);
    base.fill(5, 0, 40); // row 0
    base[3] = LOGIC_CELL;
    const empty = new Uint16Array(40 * 29);
    const room = { ...room55, base, overlay: empty, records: [] };
    expect(fillRegion(room, "base", 0)).toEqual([0, 1, 2]);
    expect(fillRegion(room, "base", 3)).toEqual([]);
    expect(fillRegion(room, "base", 10, { x: 8, y: 0, w: 4, h: 1 })).toEqual([8, 9, 10, 11]);
    expect(fillRegion(room, "overlay", 0).length).toBe(40 * 29);
  });
});

describe("Editor room settings", () => {
  test("a setting is one undo step and saved", () => {
    const editor = new Editor(game);
    expect(editor.setRoomSettings(1, 43, { darkness: 70, music: "SADMELO" })?.tags).toBeDefined();
    const saved = new Game(editor.save()).room(1, 43);
    expect(roomSettings(saved)).toMatchObject({ darkness: 70, music: "SADMELO" });
    editor.undo();
    expect(editor.room(1, 43).tags).toEqual(room.tags);
    expect(editor.isEdited(1, 43)).toBe(false);
  });

  test("an unchanged or impossible setting changes nothing", () => {
    const editor = new Editor(game);
    const { points } = roomSettings(room);
    expect(editor.setRoomSettings(1, 43, { points })).toBeUndefined();
    expect(() => editor.setRoomSettings(1, 43, { darkness: 200 })).toThrow(RangeError);
    expect(editor.canUndo).toBe(false);
  });
});

describe("Editor rooms and names", () => {
  test("a walled room has the episode's wall all around and five exit tiles per edge", () => {
    const editor = new Editor(game);
    expect(editor.wallCells(1)[0]).toBe(0x0006);
    expect(editor.wallCells(2)[0]).toBe(0x0026);
    expect(editor.wallCells(4)[0]).toBe(0x0a4e);
    expect(editor.exitCells(1)).toEqual([0x0017]);
    expect(editor.exitCells(3)[0]).toBe(0x0055); // episode III: no exit tiles, barriers
    expect(editor.exitCells(2)[0]).toBe(0x0017);
    const room = defined(editor.addRoom(1, 251, { walls: 6, exits: 0x17 }).added);
    const row = (y: number) => Array.from(room.base.subarray(y * 40, y * 40 + 40));
    const exits = (cells: number[]) => cells.flatMap((c, k) => (c === 0x17 ? [k] : []));
    expect(row(0).every((c) => c === 6)).toBe(true); // under the status line
    expect(exits(row(1))).toEqual([17, 18, 19, 20, 21]);
    expect(exits(row(28))).toEqual([17, 18, 19, 20, 21]);
    const column = (x: number) => Array.from({ length: 29 }, (_, y) => room.base[y * 40 + x] ?? 0);
    expect(exits(column(0))).toEqual([12, 13, 14, 15, 16]);
    expect(exits(column(39))).toEqual([12, 13, 14, 15, 16]);
    expect(
      row(10)
        .slice(1, 39)
        .every((c) => c === 0),
    ).toBe(true);
  });

  test("a copied room is a new room with the same content, undone as one step", () => {
    const editor = new Editor(game);
    const id = defined(editor.freeRoomId(1, 43));
    expect(game.episode(1).rooms.some((r) => r.id === id)).toBe(false);
    expect(editor.addRoom(1, id, { copy: 43 }).added?.id).toBe(id);
    const copy = editor.room(1, id);
    expect(firstDifference(copy.base, room.base)).toBe(-1);
    expect(copy.records).toEqual(room.records);
    expect(roomScript(copy)).toBe(roomScript(room));
    expect(editor.isEdited(1, id)).toBe(true);
    // the copy is its own: painting it leaves the original alone
    editor.beginStroke(1, id, "base");
    editor.paint(free, 0x0105);
    editor.endStroke();
    expect(editor.room(1, 43).base[free]).toBe(room.base[free]);
    const saved = new Game(editor.save());
    expect(saved.room(1, id).base[free]).toBe(0x0105);
    expect(saved.episode(1).rooms.map((r) => r.id)).toEqual(
      [...game.episode(1).rooms.map((r) => r.id), id].sort((a, b) => a - b),
    );
    editor.undo();
    editor.undo();
    expect(editor.rooms(1).some((r) => r.id === id)).toBe(false);
    editor.redo();
    expect(editor.room(1, id).base[free]).toBe(room.base[free]);
  });

  test("an interior shows the room behind it, with a door out at each door in", () => {
    const editor = new Editor(game);
    // episode II: room 115 is the house of room 15, its door at (26, 8) (state 7: walked
    // into southwards)
    editor.removeRoom(2, 115);
    expect(editor.interiorOf(2, 115)).toEqual({ above: 15, backdrop: 15, doors: 1, stairs: 0 });
    const room = defined(editor.addRoom(2, 115, "interior").added);
    const at = (x: number, y: number) => room.base[y * 40 + x];
    expect(at(0, 1)).toBe(0x0054); // class 99 everywhere else: the backdrop's mark
    expect(at(26, 8)).toBe(0x005a); // the door out, as in the original
    expect([at(25, 8), at(27, 8)]).toEqual([0x0026, 0x0026]);
    expect([at(26, 7), at(26, 9), at(26, 10)]).toEqual([0x0054, 0, 0]);
    expect(room.base.filter((c) => c !== 0x0054)).toHaveLength(5);
    // episode IV: the stairs down of room 204 (overlay) become stairs up
    editor.removeRoom(4, 304);
    expect(editor.interiorOf(4, 304)).toMatchObject({ above: 204, backdrop: 204, stairs: 2 });
    const cellar = defined(editor.addRoom(4, 304, "interior").added);
    expect(cellar.overlay[7 * 40 + 28]).toBe(0x013d);
    expect(cellar.base[7 * 40 + 28]).toBe(0);
    // Junior and I have no class 99 tile; an interior needs the room 100 below
    expect(() => editor.interiorOf(1, 199)).toThrow(/class 99/);
    expect(() => editor.addRoom(2, 1001, "interior")).toThrow(/no room 901/);
  });

  test("an interior of an interior gets new stairs in both rooms, as one step", () => {
    const editor = new Editor(game);
    // episode II room 144 (inside 44) has no way further in: stairs at one of its floor cells
    const below = game.room(2, 144);
    const cell = below.base.findIndex((c, i) => i > 80 && c === 0 && below.overlay[i] === 0);
    expect(editor.interiorOf(2, 244)).toEqual({ above: 144, backdrop: 44, doors: 0, stairs: 0 });
    const room = defined(editor.addRoom(2, 244, { interior: { stairs: cell } }).added);
    expect(editor.room(2, 144).base[cell]).toBe(0x003d);
    expect(room.base[cell]).toBe(0x013d);
    expect([room.base[cell - 1], room.base[cell + 1], room.base[cell + 40]]).toEqual([0, 0, 0]);
    editor.undo();
    expect(editor.room(2, 144).base[cell]).toBe(0);
    expect(editor.rooms(2).some((r) => r.id === 244)).toBe(false);
    expect(editor.interiorStairsProblem(2, 244, 5)).toMatch(/status line/);
    expect(editor.interiorStairsProblem(2, 244, 40)).toMatch(/class 99/);
    // room 144 has no logic cell: one added for the check
    expect(below.base.some((c) => (c & 0xff) === LOGIC_CELL)).toBe(false);
    editor.addRecord(2, 144, "base", cell, 13);
    expect(editor.interiorStairsProblem(2, 244, cell)).toMatch(/logic record/);
    editor.undo();
    expect(() => editor.addRoom(2, 244, { interior: { stairs: 40 } })).toThrow(RangeError);
  });

  test("an added room is empty; ids must be free and in range", () => {
    const editor = new Editor(game);
    editor.addRoom(1, 999);
    expect(editor.room(1, 999).base.every((c) => c === 0)).toBe(true);
    expect(editor.room(1, 999).tags).toEqual([]);
    expect(() => editor.addRoom(1, 999)).toThrow(RangeError);
    expect(() => editor.addRoom(1, 43)).toThrow(RangeError);
    expect(() => editor.addRoom(1, 1024)).toThrow(RangeError);
    expect(() => editor.addRoom(1, 0)).toThrow(RangeError);
  });

  test("room names are set in the episode's style, saved and undone", () => {
    const editor = new Editor(game);
    expect(editor.setRoomName(1, 43, "NEUER START")?.text).toBeDefined();
    expect(editor.roomName(1, 43)).toEqual({ room: 43, name: "NEUER START" });
    expect(editor.roomName(1, 42)).toEqual(game.roomName(1, 42));
    expect(editor.isEdited(1, 43)).toBe(true);
    expect(editor.isEdited(1, 42)).toBe(false);
    const saved = new Game(editor.save());
    expect(saved.roomName(1, 43)?.name).toBe("NEUER START");
    expect(saved.episodeTexts(1)?.entries.get(1043)).toEqual(["NEUER START\\\n═══════════"]);
    editor.undo();
    expect(editor.roomName(1, 43)?.name).toBe("DER START");
    expect(editor.isEdited(1, 43)).toBe(false);
    // a new room gets a name; caves name the room above; no name: "Szene <id>"
    editor.addRoom(2, 599);
    editor.setRoomName(2, 599, "Der neue Raum");
    expect(editor.roomName(2, 599)?.name).toBe("Der neue Raum");
    expect(editor.nameRoom(2, 143)).toBe(43);
    editor.setRoomName(2, 143, "Die Pyramiden");
    expect(editor.roomName(2, 43)?.name).toBe("Die Pyramiden");
    editor.setRoomName(2, 43, "");
    expect(editor.roomName(2, 43)).toBeUndefined();
    editor.addRoom(1, 300); // episode I names rooms below 300 only
    expect(() => editor.setRoomName(1, 300, "x")).toThrow(RangeError);
    expect(() => editor.setRoomName(2, 44, "a;b")).toThrow(RangeError);
    expect(() => editor.setRoomName(2, 44, "€")).toThrow(RangeError);
  });

  test("room descriptions follow the name, saved and undone", () => {
    const editor = new Editor(game);
    expect(editor.setRoomDescription(1, 43, "Hier beginnt es.\nViel Glück!")?.text).toBeDefined();
    expect(editor.roomName(1, 43)).toEqual({
      room: 43,
      name: "DER START",
      description: "Hier beginnt es.\nViel Glück!",
    });
    expect(editor.isEdited(1, 43)).toBe(true);
    const saved = new Game(editor.save());
    expect(saved.episodeTexts(1)?.entries.get(1043)).toEqual([
      "DER START\\\n═════════\\\n\\\nHier beginnt es.\\\nViel Glück!",
    ]);
    // renaming keeps the description
    editor.setRoomName(1, 43, "START");
    expect(editor.roomName(1, 43)?.description).toBe("Hier beginnt es.\nViel Glück!");
    editor.undo();
    editor.undo();
    expect(editor.roomName(1, 43)).toEqual(game.roomName(1, 43));
    // episode III: a "!" entry; caves describe the room above
    expect(editor.setRoomDescription(3, 43, "")).toBeDefined();
    expect(editor.roomName(3, 43)?.description).toBeUndefined();
    expect(
      editor.setRoomDescription(3, 11, game.roomName(3, 11)?.description ?? ""),
    ).toBeUndefined();
    expect(editor.nameRoom(3, 111)).toBe(11);
    editor.setRoomDescription(3, 111, "Ein Haus.");
    expect(editor.roomName(3, 11)?.description).toBe("Ein Haus.");
    expect(() => editor.setRoomDescription(3, 11, "x".repeat(990))).toThrow(RangeError);
    expect(() => editor.setRoomDescription(3, 11, "a;b")).toThrow(RangeError);
    editor.setRoomName(2, 43, "");
    expect(() => editor.setRoomDescription(2, 43, "Wald")).toThrow(RangeError);
  });

  test("the test exe starts the episode in the room, with the edits", () => {
    const editor = new Editor(game);
    editor.addRoom(1, 999, { copy: 43 });
    const exe = editor.testExe(1, 999, { x: 10, y: 12 });
    expect(readEpisodeStart(parsePe(exe), 1)).toEqual({ room: 999, x: 10, y: 12 });
    expect(new Game(exe).episode(1).rooms.some((r) => r.id === 999)).toBe(true);
    expect(readEpisodeStart(parsePe(editor.testExe(1, 44)), 1)).toEqual({ room: 44, x: 5, y: 14 });
    expect(editor.dirty).toBe(true); // not saved
    expect(() => editor.testExe(1, 998)).toThrow();
  });
});

describe("Editor room deletion", () => {
  test("a deleted room is gone from the saved exe and comes back on undo", () => {
    const editor = new Editor(game);
    const original = editor.room(1, 44);
    expect(editor.removeRoom(1, 44).removed).toBe(original);
    expect(editor.rooms(1).some((r) => r.id === 44)).toBe(false);
    expect(new Game(editor.save()).episode(1).rooms.some((r) => r.id === 44)).toBe(false);
    editor.undo();
    expect(editor.room(1, 44)).toBe(original);
    expect(editor.isEdited(1, 44)).toBe(false);
    expect(editor.rooms(1).map((r) => r.id)).toEqual(game.episode(1).rooms.map((r) => r.id));
    editor.redo();
    expect(editor.rooms(1).some((r) => r.id === 44)).toBe(false);
  });

  test("added rooms can be deleted; the title and start rooms cannot", () => {
    const editor = new Editor(game);
    editor.addRoom(3, 250, { copy: 41 });
    editor.removeRoom(3, 250);
    expect(editor.rooms(3).some((r) => r.id === 250)).toBe(false);
    expect(() => editor.removeRoom(3, 41)).toThrow(RangeError);
    expect(() => editor.removeRoom(3, 1)).toThrow(RangeError);
    expect(() => editor.removeRoom(3, 250)).toThrow();
  });
});

describe("Editor and mods", () => {
  /** The rooms, text entries, other resources and code of two exes are the same. */
  function sameContent(a: Game, b: Game): void {
    for (const episode of [0, 1, 2, 3, 4]) {
      const ids = (g: Game) => g.episode(episode).rooms.map((r) => r.id);
      expect(ids(a)).toEqual(ids(b));
      for (const room of a.episode(episode).rooms) {
        expect(serializeRoom(room)).toEqual(serializeRoom(b.room(episode, room.id)));
      }
    }
    const resources = (g: Game) => g.resources.filter((r) => r.type !== "SCENE");
    for (const r of resources(a)) {
      if (r.type === "CRUNCHED") {
        expect(a.texts(Number(r.name))?.entries, `texts ${String(r.name)}`).toEqual(
          b.texts(Number(r.name))?.entries,
        );
      } else {
        const other = findResource(b.resources, r.type, r.name, r.language)?.data ?? [];
        const key = `${String(r.type)}/${String(r.name)}/${r.language}`;
        expect(firstDifference(r.data, other), key).toBe(-1);
      }
    }
    for (const s of a.image.sections.filter((s) => s.name !== ".rsrc")) {
      const bytes = (g: Game) => g.image.data.subarray(s.rawOffset, s.rawOffset + s.rawSize);
      expect(firstDifference(bytes(a), bytes(b)), s.name).toBe(-1);
    }
  }

  test("the exe a saved mod makes holds what the editor saves", () => {
    const editor = new Editor(game);
    paint(editor, free, 0x0105);
    editor.setRoomName(1, 43, "NEUER START");
    editor.setRoomDescription(3, 11, "Ein Haus.");
    editor.addRoom(1, 999, { copy: 43 });
    editor.removeRoom(1, 44);
    const mod = editor.saveMod();
    expect(editor.dirty).toBe(false);
    expect(mod.base).toBe(sha256(game.image.data));
    expect(mod.changes.rooms.map((c) => [c.episode, c.id, c.room === null])).toEqual([
      [1, 43, false],
      [1, 44, true],
      [1, 999, false],
    ]);
    expect(mod.changes.texts.map((c) => [c.resource, c.entry])).toEqual([
      [1110, 1043],
      [1320, 1011],
    ]);
    sameContent(new Game(applyMod(game.image, parseMod(modJson(mod)))), new Game(editor.save()));
  });

  /** Episode I's circuit pieces in III, II's oracle hint in I, room 41 changed, a start. */
  function aMod(): Mod {
    const room41 = game.room(3, 41);
    const base = room41.base.slice();
    base[2 + 16 * 40] = 0x0a59;
    return {
      ...emptyMod(game.image.data, "test"),
      author: "someone",
      changes: {
        ...NO_CHANGES,
        tileTypes: [{ episode: 3, from: 1, types: [[0x59, 0x42]] }],
        copyTexts: [
          {
            resource: 1110,
            from: 1210,
            entries: [
              [331, 331],
              [1044, 1043],
            ],
          },
        ],
        texts: [{ resource: 1110, entry: 1042, variants: ["DER ANFANG"] }],
        rooms: [{ episode: 3, id: 41, room: { ...room41, base } }],
        start: [{ episode: 3, room: 41, x: 2, y: 16 }],
      },
    };
  }

  test("a mod is where editing starts; unchanged, it saves as it came", () => {
    const mod = aMod();
    const editor = new Editor(game, mod);
    expect(editor.dirty).toBe(false);
    expect(editor.game.episode(3).classes.typeOfClass.get(76)).toBe(0x59);
    expect(editor.room(3, 41).base[2 + 16 * 40]).toBe(0x0a59);
    expect(editor.isEdited(3, 41)).toBe(true);
    expect(editor.isEdited(3, 42)).toBe(false);
    expect(editor.roomName(1, 42)?.name).toBe("DER ANFANG");
    expect(editor.roomName(1, 44)?.name).toBe(game.roomName(2, 43)?.name);
    expect(editor.start(3)).toEqual({ room: 41, x: 2, y: 16 });
    expect(editor.isStartEdited(3)).toBe(true);
    expect(modJson(editor.saveMod())).toBe(modJson(mod));
    sameContent(new Game(editor.save()), new Game(applyMod(game.image, mod)));
  });

  test("a text entry written in the editor replaces its copy", () => {
    const editor = new Editor(game, aMod());
    editor.setRoomName(1, 44, "DER GANG");
    const { copyTexts, texts } = editor.saveMod().changes;
    expect(copyTexts).toEqual([{ resource: 1110, from: 1210, entries: [[331, 331]] }]);
    expect(texts.map((c) => c.entry)).toEqual([1042, 1044]);
  });

  test("the mod's code: listed, written over by edits here, taken out as one step", () => {
    // III's start method: the hero's x (c6 05 09 e3 4f 00 xx); III's event entry 16's points
    const startX = 0x40b460 + 6;
    const points = 0x4780d8 + 12 * 16 + 4;
    const code = [
      { va: points, expect: readVa(game.image, points, 4), bytes: Uint8Array.of(1, 2, 0, 0) },
      { va: startX, expect: readVa(game.image, startX, 1), bytes: Uint8Array.of(5) },
    ];
    const mod: Mod = { ...emptyMod(game.image.data, "code"), changes: { ...NO_CHANGES, code } };
    const editor = new Editor(game, mod);
    expect(modJson(editor.saveMod())).toBe(modJson(mod));
    const start = readEpisodeStart(game.image, 3);
    expect(readEpisodeStart(editor.game.image, 3)).toEqual({ ...start, x: 5 });
    expect(editor.codePatches().map((p) => [p.va, p.section, p.overwritten])).toEqual([
      [startX, ".text", 0],
      [points, ".data", 0],
    ]);
    // a start set here writes the same byte
    editor.setStart(3, { ...start, x: 7 });
    expect(editor.codePatches()[0]?.overwritten).toBe(1);
    editor.undo();
    expect(editor.codePatches()[0]?.overwritten).toBe(0);
    const edit = editor.removeCode(3, start.room, startX);
    expect(edit?.room).toBe(start.room);
    expect(editor.removeCode(3, start.room, startX)).toBeUndefined();
    expect(editor.codePatches().map((p) => p.va)).toEqual([points]);
    expect(readEpisodeStart(editor.game.image, 3)).toEqual(start);
    expect(editor.saveMod().changes.code).toEqual([code[0]]);
    editor.removeCode(3, start.room, points);
    expect(editor.game).toBe(game);
    editor.undo();
    editor.undo();
    expect(editor.codePatches()).toHaveLength(2);
    expect(readEpisodeStart(editor.game.image, 3).x).toBe(5);
  });

  test("code written here: what the base holds expected; refused where it cannot go", () => {
    const editor = new Editor(game);
    const start = readEpisodeStart(game.image, 3);
    const startX = 0x40b460 + 6;
    expect(editor.codeBytes(startX, 1)).toEqual(readVa(game.image, startX, 1));
    expect(editor.codeBytes(0x10, 1)).toBeUndefined();
    editor.addCode(3, start.room, startX, Uint8Array.of(5));
    expect(readEpisodeStart(editor.game.image, 3).x).toBe(5);
    const [patch] = editor.saveMod().changes.code;
    expect(patch).toEqual({
      va: startX,
      expect: readVa(game.image, startX, 1),
      bytes: Uint8Array.of(5),
    });
    expect(editor.codePatches().map((p) => p.section)).toEqual([".text"]);
    // the resources, no bytes, an overlap, what the exe holds already
    const rsrc = game.image.sections.find((s) => s.name === ".rsrc");
    if (!rsrc) throw new Error("no .rsrc");
    expect(
      editor.codeProblem(game.image.imageBase + rsrc.virtualAddress, Uint8Array.of(1)),
    ).toMatch(/no code or data/);
    expect(editor.codeProblem(startX, new Uint8Array())).toBe("no bytes");
    expect(editor.codeProblem(startX - 1, Uint8Array.of(1, 2))).toMatch(/patch at 0x40b466 covers/);
    const held = readVa(game.image, startX + 1, 2);
    expect(editor.codeProblem(startX + 1, held)).toMatch(/holds these bytes .* already/);
    expect(() => editor.addCode(3, start.room, startX, Uint8Array.of(6))).toThrow(RangeError);
    editor.undo();
    expect(editor.game).toBe(game);
    expect(editor.codePatches()).toEqual([]);
  });

  test("a mod for another exe is refused", () => {
    const editor = new Editor(game);
    paint(editor, free, 0x0105);
    expect(() => new Editor(new Game(editor.save()), aMod())).toThrow(/for another exe/);
  });
});

describe("Editor and the start", () => {
  test("the start changes as one step, saved into the exe and the mod, and undone", () => {
    const editor = new Editor(game);
    expect(editor.start(1)).toEqual({ room: 43, x: 5, y: 14 });
    const edit = editor.setStart(1, { room: 44, x: 10, y: 12 });
    expect(edit?.room).toBe(44);
    expect(editor.isStartEdited(1)).toBe(true);
    expect(editor.setStart(1, { room: 44, x: 10, y: 12 })).toBeUndefined();
    expect(readEpisodeStart(parsePe(editor.save()), 1)).toEqual({ room: 44, x: 10, y: 12 });
    // the test exe starts in the shown room at the new start's cell
    expect(readEpisodeStart(parsePe(editor.testExe(1, 42)), 1)).toEqual({ room: 42, x: 10, y: 12 });
    // the start room cannot be deleted, the old one now can
    expect(() => editor.removeRoom(1, 44)).toThrow(/starts in room 44/);
    editor.undo();
    expect(editor.start(1)).toEqual({ room: 43, x: 5, y: 14 });
    expect(editor.isStartEdited(1)).toBe(false);
    expect(editor.saveMod().changes.start).toEqual([]);
    editor.redo();
    const mod = editor.saveMod();
    expect(mod.changes.start).toEqual([{ episode: 1, room: 44, x: 10, y: 12 }]);
    const fromMod = applyMod(game.image, parseMod(modJson(mod)));
    expect(firstDifference(fromMod, editor.save())).toBe(-1);
    const opened = new Editor(game, mod);
    expect(opened.start(1)).toEqual({ room: 44, x: 10, y: 12 });
    expect(readEpisodeStart(opened.game.image, 1)).toEqual({ room: 43, x: 5, y: 14 });
    expect(modJson(opened.saveMod())).toBe(modJson(mod));
  });

  test("a start in a new room; none outside the rooms, the title or the room", () => {
    const editor = new Editor(game);
    editor.addRoom(3, 250, { copy: 41 });
    editor.setStart(3, { room: 250, x: 2, y: 16 });
    expect(readEpisodeStart(parsePe(editor.save()), 3)).toEqual({ room: 250, x: 2, y: 16 });
    expect(editor.startProblem(3, { room: 251, x: 2, y: 16 })).toMatch(/no room 251/);
    expect(() => editor.setStart(3, { room: 1, x: 2, y: 16 })).toThrow(/title screen/);
    expect(() => editor.setStart(3, { room: 41, x: 40, y: 16 })).toThrow(RangeError);
    expect(() => editor.setStart(3, { room: 41, x: 2, y: 0 })).toThrow(/status line/);
  });
});

describe("Editor and tile types from other episodes", () => {
  test("a copy makes a new base, one undo step; saved into exe and mod", () => {
    const editor = new Editor(game);
    // III has 18 types without a class; room 99 uses 0x11
    expect(editor.freeTileTypes(3)).toHaveLength(17);
    expect(editor.freeTileTypes(3)).not.toContain(0x11);
    expect(editor.game.episode(3).classes.classes.get(0x59)?.id).toBe(0);
    // episode I's GATE (class 76) at III's free type 0x59
    const edit = editor.setTileType(3, 41, 0x59, { from: 1, of: 0x42 });
    expect(edit?.room).toBe(41);
    expect(editor.game.episode(3).classes.classes.get(0x59)?.id).toBe(76);
    expect(editor.tileTypeCopies(3)).toEqual([{ episode: 3, to: 0x59, from: 1, of: 0x42 }]);
    expect(editor.setTileType(3, 41, 0x59, { from: 1, of: 0x42 })).toBeUndefined();
    const mod = editor.saveMod();
    expect(mod.changes.tileTypes).toEqual([{ episode: 3, from: 1, types: [[0x59, 0x42]] }]);
    expect(firstDifference(applyMod(game.image, parseMod(modJson(mod))), editor.save())).toBe(-1);
    const opened = new Editor(game, mod);
    expect(opened.tileTypeCopies(3)).toEqual(editor.tileTypeCopies(3));
    expect(modJson(opened.saveMod())).toBe(modJson(mod));
    editor.undo();
    expect(editor.game).toBe(game);
    expect(editor.tileTypeCopies(3)).toEqual([]);
    editor.redo();
    expect(editor.game.episode(3).classes.classes.get(0x59)?.id).toBe(76);
  });

  test("text entries edited before a copy stay; the copy's description comes along", () => {
    const editor = new Editor(game);
    editor.setRoomName(1, 44, "DER GANG");
    editor.setTileType(1, 43, 0x50, { from: 2, of: 0x50 });
    expect(editor.roomName(1, 44)?.name).toBe("DER GANG");
    const texts = (g: Game) => g.episodeTexts(1)?.entries;
    expect(game.episodeTexts(2)?.entries.get(0x50)).toBeDefined();
    expect(texts(new Game(editor.save()))?.get(0x50)).toEqual(
      game.episodeTexts(2)?.entries.get(0x50),
    );
    expect(editor.saveMod().changes.texts.map((c) => c.entry)).toEqual([1044]);
    editor.undo();
    expect(editor.roomName(1, 44)?.name).toBe("DER GANG");
    expect(texts(new Game(editor.save()))?.has(0x50)).toBe(false);
  });

  test("refused: no free type, no class there, a copy of a copy, a type rooms use", () => {
    const editor = new Editor(game);
    expect(editor.freeTileTypes(2)).toEqual([]);
    expect(() => editor.setTileType(2, 43, 0x50, { from: 1, of: 0x42 })).toThrow(/not free/);
    expect(() => editor.setTileType(3, 41, 0x59, { from: 3, of: 0x42 })).toThrow(/another/);
    expect(() => editor.setTileType(3, 41, 0x59, { from: 0, of: 0x50 })).toThrow(/no class/);
    editor.setTileType(0, 43, 0x50, { from: 2, of: 0x50 });
    expect(() => editor.setTileType(3, 41, 0x59, { from: 0, of: 0x50 })).toThrow(/a copy itself/);
    // a tangram piece painted in Junior: the copy stays
    editor.beginStroke(0, 43, "base");
    editor.paint(ROOM_CELLS - 50, 0x50);
    editor.endStroke();
    expect(() => editor.setTileType(0, 43, 0x50, undefined)).toThrow(/rooms 43 use/);
    expect(editor.freeTileTypes(0)).toContain(0x50);
  });
});

describe("Editor and events from other episodes", () => {
  /** Episode IV's room the tests show (any: it is where undo goes). */
  const shown = readEpisodeStart(game.image, 4).room;

  test("II's oracle events in IV's spare entries: a new base, saved as the driver test's mod", () => {
    const editor = new Editor(game);
    expect(editor.eventTargets(4)).toEqual([197, 198, 199, 200]);
    // II's entries 134-143 are the oracles' events 262-271, which IV lacks; II's 128
    // (event 256) IV has
    const sources = editor.sourceEvents(2, 4);
    expect(sources).toContain(135);
    expect(sources).not.toContain(128);
    editor.copyEvent(4, shown, 197, { from: 2, of: 135 });
    const edit = editor.copyEvent(4, shown, 198, { from: 2, of: 138 });
    expect(edit?.room).toBe(shown);
    expect(editor.copyEvent(4, shown, 198, { from: 2, of: 138 })).toBeUndefined();
    expect(readEventTable(editor.game.image, 4).slice(197, 199)).toEqual([
      { id: 263, points: 3500 },
      { id: 266, points: 3500 },
    ]);
    expect(editor.game.texts(1410)?.entries.get(1997)).toEqual(game.texts(1210)?.entries.get(1935));
    expect(editor.eventEntries(4)).toEqual([
      { episode: 4, entry: 197, id: 263, points: 3500, text: { from: 2, of: 135 } },
      { episode: 4, entry: 198, id: 266, points: 3500, text: { from: 2, of: 138 } },
    ]);
    expect(editor.sourceEvents(2, 4)).not.toContain(135);
    const mod = editor.saveMod();
    expect(mod.changes.events).toEqual([
      { episode: 4, entry: 197, id: 263, points: 3500 },
      { episode: 4, entry: 198, id: 266, points: 3500 },
    ]);
    expect(mod.changes.copyTexts).toEqual([
      {
        resource: 1410,
        from: 1210,
        entries: [
          [1997, 1935],
          [1998, 1938],
        ],
      },
    ]);
    expect(firstDifference(applyMod(game.image, parseMod(modJson(mod))), editor.save())).toBe(-1);
    const opened = new Editor(game, mod);
    expect(opened.eventEntries(4)).toEqual(editor.eventEntries(4));
    expect(modJson(opened.saveMod())).toBe(modJson(mod));
    editor.undo();
    editor.undo();
    expect(editor.game).toBe(game);
    expect(editor.eventEntries(4)).toEqual([]);
    editor.redo();
    expect(editor.eventEntries(4).map((e) => e.entry)).toEqual([197]);
  });

  test("a copy replaces the entry's copy, text and all; × takes it back", () => {
    const editor = new Editor(game);
    editor.copyEvent(4, shown, 197, { from: 2, of: 135 });
    // episode I's 262 has no text: the entry keeps none
    editor.copyEvent(4, shown, 197, { from: 1, of: 134 });
    expect(editor.eventEntries(4)).toEqual([{ episode: 4, entry: 197, id: 262, points: 3500 }]);
    expect(editor.saveMod().changes.copyTexts).toEqual([]);
    expect(editor.game.texts(1410)?.entries.has(1997)).toBe(false);
    editor.copyEvent(4, shown, 197, undefined);
    expect(editor.eventEntries(4)).toEqual([]);
    expect(editor.copyEvent(4, shown, 197, undefined)).toBeUndefined();
    expect(editor.game).toBe(game);
  });

  test("a copy takes its sound where the episode has the piece; × gives the line back", () => {
    const editor = new Editor(game);
    // I's thief bribe (entry 130, event 258) sounds !THIEFIRI; IV has the piece, no line 197
    editor.copyEvent(4, shown, 197, { from: 1, of: 130 });
    expect(editor.eventEntries(4)).toEqual([
      {
        episode: 4,
        entry: 197,
        id: 258,
        points: 5000,
        sound: "!THIEFIRI",
        text: { from: 1, of: 130 },
      },
    ]);
    expect(editor.game.sound(4, 197)).toBe("!THIEFIRI");
    const mod = editor.saveMod();
    expect(mod.changes.events).toEqual([
      { episode: 4, entry: 197, id: 258, points: 5000, sound: "!THIEFIRI" },
    ]);
    expect(firstDifference(applyMod(game.image, parseMod(modJson(mod))), editor.save())).toBe(-1);
    // II's oracle event: IV lacks !ORACLE, the line stays as the exe has it
    editor.copyEvent(4, shown, 197, { from: 2, of: 135 });
    expect(editor.eventEntries(4)[0]?.sound).toBeUndefined();
    expect(editor.game.sound(4, 197)).toBe("");
    editor.copyEvent(4, shown, 197, undefined);
    expect(editor.game).toBe(game);
  });

  test("text entries edited before a copy stay", () => {
    const editor = new Editor(game);
    editor.setRoomName(4, shown, "DER ANFANG");
    editor.copyEvent(4, shown, 197, { from: 2, of: 135 });
    expect(editor.roomName(4, shown)?.name).toBe("DER ANFANG");
    const texts = new Game(editor.save()).texts(1410)?.entries;
    expect(texts?.get(1997)).toEqual(game.texts(1210)?.entries.get(1935));
    editor.undo();
    expect(editor.roomName(4, shown)?.name).toBe("DER ANFANG");
  });

  test("refused: the same episode, no spare entry, no event there, an id the table has", () => {
    const editor = new Editor(game);
    expect(editor.eventTargets(2)).toEqual([]);
    expect(() => editor.copyEvent(4, shown, 197, { from: 4, of: 135 })).toThrow(/another/);
    expect(() => editor.copyEvent(2, 43, 190, { from: 1, of: 134 })).toThrow(/never uses/);
    expect(() => editor.copyEvent(4, shown, 196, { from: 2, of: 134 })).toThrow(/never uses/);
    // Junior's 190 is spare (id 0), entries below 128 are tile types
    expect(() => editor.copyEvent(4, shown, 197, { from: 0, of: 190 })).toThrow(/no event/);
    expect(() => editor.copyEvent(4, shown, 197, { from: 2, of: 21 })).toThrow(/no event/);
    expect(() => editor.copyEvent(4, shown, 197, { from: 2, of: 128 })).toThrow(
      /has event 256 already \(entry 128\)/,
    );
    editor.copyEvent(4, shown, 197, { from: 2, of: 135 });
    expect(() => editor.copyEvent(4, shown, 198, { from: 3, of: 155 })).toThrow(
      /has event 263 already \(entry 197\)/,
    );
  });
});

describe("Editor and texts from other episodes", () => {
  const ivRoom = readEpisodeStart(game.image, 4).room;

  test("II's oracle hint in Junior: a new base, one undo step, saved into exe and mod", () => {
    const editor = new Editor(game);
    expect(game.texts(1010)?.entries.has(331)).toBe(false);
    const edit = editor.setTextCopies(0, 43, [{ to: 331, source: { from: 2, of: 331 } }]);
    expect(edit?.room).toBe(43);
    expect(
      editor.setTextCopies(0, 43, [{ to: 331, source: { from: 2, of: 331 } }]),
    ).toBeUndefined();
    expect(editor.textCopies(0)).toEqual([{ to: 331, from: 2, of: 331 }]);
    expect(editor.game.texts(1010)?.entries.get(331)).toEqual(game.texts(1210)?.entries.get(331));
    const mod = editor.saveMod();
    expect(mod.changes.copyTexts).toEqual([{ resource: 1010, from: 1210, entries: [[331, 331]] }]);
    expect(mod.changes.texts).toEqual([]);
    expect(firstDifference(applyMod(game.image, parseMod(modJson(mod))), editor.save())).toBe(-1);
    const opened = new Editor(game, mod);
    expect(opened.textCopies(0)).toEqual(editor.textCopies(0));
    expect(modJson(opened.saveMod())).toBe(modJson(mod));
    // another source for the entry replaces the copy; undefined takes it back
    editor.setTextCopies(0, 43, [{ to: 331, source: { from: 2, of: 334 } }]);
    expect(editor.textCopies(0)).toEqual([{ to: 331, from: 2, of: 334 }]);
    editor.setTextCopies(0, 43, [{ to: 331, source: undefined }]);
    expect(editor.textCopies(0)).toEqual([]);
    expect(editor.game).toBe(game);
    editor.undo();
    editor.undo();
    expect(editor.textCopies(0)).toEqual([{ to: 331, from: 2, of: 331 }]);
    editor.undo();
    expect(editor.game).toBe(game);
  });

  test("a copied oracle brings the texts its class shows, all in one step", () => {
    const editor = new Editor(game);
    expect(game.episode(2).classes.classes.get(0x51)?.id).toBe(ORACLE_CLASS);
    editor.setTileType(0, 43, 0x51, { from: 2, of: 0x51 });
    const [copy] = editor.tileTypeCopies(0);
    // II's hints and its death message; Junior has none of them
    const texts = editor.classTextsToCopy(defined(copy));
    expect(texts).toEqual([331, 332, 334, 339, 945]);
    editor.setTextCopies(
      0,
      43,
      texts.map((n) => ({ to: n, source: { from: 2, of: n } })),
    );
    expect(editor.textCopies(0).map((c) => c.to)).toEqual(texts);
    expect(editor.classTextsToCopy(defined(copy))).toEqual([]);
    editor.undo();
    expect(editor.textCopies(0)).toEqual([]);
    // a class without such texts: nothing to copy along
    editor.setTileType(3, 41, 0x59, { from: 1, of: 0x42 });
    expect(editor.classTextsToCopy(defined(editor.tileTypeCopies(3)[0]))).toEqual([]);
  });

  test("event texts are not listed here and stay when a text copy goes", () => {
    const editor = new Editor(game);
    editor.copyEvent(4, ivRoom, 197, { from: 2, of: 135 });
    editor.setTextCopies(4, ivRoom, [{ to: 945, source: { from: 2, of: 945 } }]);
    expect(editor.textCopies(4)).toEqual([{ to: 945, from: 2, of: 945 }]);
    editor.setTextCopies(4, ivRoom, [{ to: 945, source: undefined }]);
    expect(editor.saveMod().changes.copyTexts).toEqual([
      { resource: 1410, from: 1210, entries: [[1997, 1935]] },
    ]);
  });

  test("refused: the same episode, an event text, a text the source lacks", () => {
    const editor = new Editor(game);
    const copy = (to: number, from: number, of: number) =>
      editor.setTextCopies(0, 43, [{ to, source: { from, of } }]);
    expect(() => copy(331, 0, 331)).toThrow(/another episode/);
    expect(() => copy(1990, 2, 331)).toThrow(/event texts/);
    // II has no hint 330
    expect(() => copy(330, 2, 330)).toThrow(/no text 330/);
    // a refused copy among several changes nothing
    expect(() =>
      editor.setTextCopies(0, 43, [
        { to: 331, source: { from: 2, of: 331 } },
        { to: 330, source: { from: 2, of: 330 } },
      ]),
    ).toThrow(RangeError);
    expect(editor.textCopies(0)).toEqual([]);
  });
});

describe("Editor and kits", () => {
  const ivRoom = readEpisodeStart(game.image, 4).room;
  const kit = (key: string) => defined(KITS.find((k) => k.key === key));

  test("oracles in IV: types, texts, chosen events and their texts in one undo step", () => {
    const editor = new Editor(game);
    const oracles = kit("oracles");
    const edit = editor.addKit(4, ivRoom, oracles, [263, 266]);
    expect(edit?.room).toBe(ivRoom);
    expect(editor.tileTypeCopies(4).map((c) => [c.to, c.of])).toEqual([
      [0x48, 0x50],
      [0x6d, 0x51],
    ]);
    expect(editor.eventEntries(4).map((e) => [e.entry, e.id, e.points])).toEqual([
      [197, 263, 3500],
      [198, 266, 3500],
    ]);
    expect(editor.textCopies(4).map((c) => c.to)).toEqual([331, 332, 334, 339, 945]);
    const mod = editor.saveMod();
    expect(mod.changes).toMatchObject(
      kitChanges(game, 4, oracles, planKit(game, 4, oracles, { events: [263, 266] })),
    );
    expect(firstDifference(applyMod(game.image, parseMod(modJson(mod))), editor.save())).toBe(-1);
    // nothing left but events without an entry: two spare entries remain
    const after = editor.kitPlan(4, oracles);
    expect(after).toMatchObject({ types: [], texts: [], present: [0x50, 0x51] });
    expect(after.events.map((e) => e.entry)).toEqual([199, 200]);
    // the circuits take the next spare entry for their event 293
    editor.addKit(4, ivRoom, kit("circuits"));
    expect(editor.eventEntries(4).map((e) => e.id)).toEqual([263, 266, 293]);
    expect(editor.kitPlan(4, oracles).events.map((e) => e.entry)).toEqual([200]);
    editor.undo();
    editor.undo();
    expect(editor.game).toBe(game);
    expect(editor.saveMod().changes).toMatchObject({ tileTypes: [], events: [], copyTexts: [] });
  });

  test("a type copied by hand stays; the kit adds the rest and the class's texts", () => {
    const editor = new Editor(game);
    editor.setTileType(0, 43, 0x51, { from: 2, of: 0x51 });
    const plan = editor.kitPlan(0, kit("oracles"));
    expect(plan.types).toEqual([[0x50, 0x50]]);
    expect(plan.texts).toEqual([331, 332, 334, 339, 945]);
    editor.addKit(0, 43, kit("oracles"));
    expect(editor.tileTypeCopies(0).map((c) => c.to)).toEqual([0x50, 0x51]);
    expect(editor.addKit(0, 43, kit("oracles"))).toBeUndefined();
  });

  test("copied types offer the states their episode's rooms use: letters 0 and 1", () => {
    const editor = new Editor(game);
    editor.addKit(3, 41, kit("circuits"));
    // episode I's letter 0x25 is III's 0x0e, its gate 0x42 III's 0x0f
    const tiles = editor.tiles(3, "base");
    expect(tiles).toContain(0x0e | (0x30 << 8));
    expect(tiles).toContain(0x0e | (0x31 << 8));
    const gates = (cells: readonly number[], type: number) =>
      cells.filter((c) => (c & 0xff) === type).map((c) => c >> 8);
    for (const state of gates(tilesOf(game.episode(1).rooms, "base"), 0x42))
      expect(gates(tiles, 0x0f)).toContain(state);
  });

  test("refused: a plan with a problem; nothing to add where the episode has the feature", () => {
    const editor = new Editor(game);
    expect(() => editor.addKit(4, ivRoom, kit("oracles"), [262, 263, 264, 265, 266])).toThrow(
      /spare entries/,
    );
    expect(editor.addKit(2, 43, kit("oracles"))).toBeUndefined();
    expect(editor.addKit(1, 43, kit("circuits"))).toBeUndefined();
    expect(editor.dirty).toBe(false);
  });
});

describe("Editor and kit examples", () => {
  const kit = (key: string) => defined(KITS.find((k) => k.key === key));
  const at = (x: number, y: number) => x + y * ROOM_WIDTH;
  const nodes = (editor: Editor, episode: number, room: number) =>
    roomCircuit(editor.room(episode, room), editor.game.episode(episode).classes).nodes;

  test("the circuit lights once the missing wire lies in its gap; its stairs move along", () => {
    const editor = new Editor(game);
    expect(editor.kitExample(3, 41, kit("circuits"))).toBeUndefined();
    editor.addKit(3, 41, kit("circuits"));
    const clip = defined(editor.kitExample(3, 41, kit("circuits")));
    expect([clip.w, clip.h, clip.records.length]).toEqual([7, 3, 1]);
    editor.pasteArea(3, 41, 20, 10, clip);
    // the node at (24, 11), its stairs two cells east; 1 OR 0 does not reach it yet
    const node = nodes(editor, 3, 41).find((n) => n.cell === at(24, 11));
    expect(node?.signal).not.toBe(1);
    const record = defined(
      editor.room(3, 41).records.find((r) => r.data[0] === 11 && r.data[4] === 26),
    );
    expect([...record.data.slice(4, 7)]).toEqual([26, 11, 0]);
    // the pieces lie in the overlay, the floor under them is empty and can be painted
    expect(editor.room(3, 41).base[at(23, 12)]).toBe(0);
    // the wire lies below its gap; put there, the node is lit
    const wire = defined(editor.room(3, 41).overlay[at(23, 12)]);
    expect(wire & 0xff).toBe(0x0f);
    editor.beginStroke(3, 41, "overlay");
    editor.paint(at(23, 11), wire);
    editor.endStroke();
    const lit = nodes(editor, 3, 41).find((n) => n.cell === at(24, 11));
    expect(lit?.signal).toBe(1);
    // copied and pasted elsewhere, the stairs stay two cells east of the node
    const copy = editor.copyArea(3, 41, { x: 20, y: 10, w: 7, h: 3 });
    editor.pasteArea(3, 41, 2, 20, copy);
    const moved = editor.room(3, 41).records.filter((r) => r.data[0] === 11 && r.data[5] === 21);
    expect(moved.map((r) => r.data[4])).toEqual([8]);
  });

  test("an oracle with its symbol laid out, sending below it in the room it is put in", () => {
    const editor = new Editor(game);
    const ivRoom = readEpisodeStart(game.image, 4).room;
    editor.addKit(4, ivRoom, kit("oracles"));
    const clip = defined(editor.kitExample(4, ivRoom, kit("oracles")));
    editor.pasteArea(4, ivRoom, 5, 5, clip);
    const room = editor.room(4, ivRoom);
    // symbol 1: its event (263) has an entry, its hint 331 came with the kit
    const symbol = defined(readOracleSymbols(game.image)[1]);
    const tangram = defined(editor.tileTypeCopies(4).find((c) => c.of === 0x50)).to;
    expect([at(5, 5), at(6, 5), at(5, 6), at(6, 6)].map((i) => room.overlay[i])).toEqual(
      symbol.map((state) => tangram | (state << 8)),
    );
    const oracle = defined(room.records.find((r) => r.data[0] === 12));
    expect(oracle.data[3]).toBe(1);
    const target = defined(oracle.data[4]) | (defined(oracle.data[5]) << 8);
    expect([target & 0x3ff, target >> 10, oracle.data[6]]).toEqual([ivRoom, 5, 7]);
    // its symbol is told in the episode's tangram pieces (IV's copy at 0x48), as the
    // Record tab draws it
    const classes = editor.game.episode(4).classes;
    expect(tangramTile(classes)).toBe(tangram);
    const pieces = symbol.map((s) => `0x${(tangram | (s << 8)).toString(16).padStart(4, "0")}`);
    expect(describeRecord(oracle, classes, readOracleSymbols(game.image)).summary).toContain(
      `tangram pieces ${pieces.join(" ")}`,
    );
    expect(tangramTile(game.episode(2).classes)).toBe(0x50);
    // in episode II, whose oracles are its own, symbol 1 as well (hint 331)
    expect(new Editor(game).kitExample(2, 43, kit("oracles"))?.records[0]?.data[3]).toBe(1);
  });

  test("records keep positions outside the copied area and other rooms' targets", () => {
    const node = Uint8Array.from([11, 0, 0, 0, 30, 5, 0, 0, 0, 0]);
    const area = { room: 41, x: 0, y: 0, w: 7, h: 3 };
    expect([...movedRecord(node, area, { room: 41, x: 10, y: 10 }).slice(4, 6)]).toEqual([30, 5]);
    const elsewhere = 42 | (1 << 10);
    const oracle = Uint8Array.from([12, 0, 0, 0, elsewhere & 0xff, elsewhere >> 8, 1, 0, 0, 0]);
    expect([...movedRecord(oracle, area, { room: 41, x: 10, y: 10 })]).toEqual([...oracle]);
  });
});

describe("Editor and the episode's settings", () => {
  test("the rucksack and the flags change as one step each, saved into exe and mod", () => {
    const editor = new Editor(game);
    expect(editor.rucksack(3)).toBe(200);
    expect(editor.setRucksack(3, 41, 200)).toBeUndefined();
    editor.setRucksack(3, 41, 6);
    const oracles = ORACLE_VANISHES_NORTH | ORACLE_VANISHES_EAST;
    editor.setEpisodeFlags(0, 43, readEpisodeFlags(game.image, 0) | oracles);
    expect([editor.isRucksackEdited(3), editor.isFlagsEdited(0)]).toEqual([true, true]);
    const exe = parsePe(editor.save());
    expect(readRucksack(exe, 3)).toBe(6);
    expect(readEpisodeFlags(exe, 0)).toBe(0x4801e946);
    const mod = editor.saveMod();
    expect(mod.changes.rucksack).toEqual([{ episode: 3, capacity: 6 }]);
    expect(mod.changes.flags).toEqual([{ episode: 0, flags: 0x4801e946 }]);
    expect(firstDifference(applyMod(game.image, parseMod(modJson(mod))), editor.save())).toBe(-1);
    // a mod's settings are where editing starts, not part of the base
    const opened = new Editor(game, mod);
    expect([opened.rucksack(3), opened.episodeFlags(0)]).toEqual([6, 0x4801e946]);
    expect(readRucksack(opened.game.image, 3)).toBe(200);
    expect(modJson(opened.saveMod())).toBe(modJson(mod));
    editor.undo();
    expect(editor.episodeFlags(0)).toBe(0x48012946);
    editor.undo();
    expect(editor.rucksack(3)).toBe(200);
    expect(editor.saveMod().changes).toMatchObject({ rucksack: [], flags: [] });
    expect(() => editor.setRucksack(3, 41, 0)).toThrow(RangeError);
  });

  test("diagonal moves change as one step, saved into exe and mod", () => {
    const editor = new Editor(game);
    expect([0, 1, 2, 3, 4].map((e) => editor.diagonalMoves(e))).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
    editor.setDiagonalMoves(0, 43, true);
    expect(readDiagonalMoves(parsePe(editor.save()), 0)).toBe(true);
    const mod = editor.saveMod();
    expect(mod.changes.moves).toEqual([{ episode: 0, diagonal: true }]);
    expect(new Editor(game, mod).diagonalMoves(0)).toBe(true);
    editor.undo();
    expect(editor.saveMod().changes.moves).toEqual([]);
  });

  test("the backdrop rule changes as one step; what is drawn behind follows", () => {
    const editor = new Editor(game);
    editor.addRoom(2, 244, { copy: 115 });
    expect(editor.backdropOf(2, editor.room(2, 244))?.id).toBe(44);
    editor.setBackdropRule(2, 244, "minus100");
    expect(editor.backdropOf(2, editor.room(2, 244))?.id).toBe(144);
    expect(editor.backdropRule(2)).toBe("minus100");
    expect(readBackdropRule(parsePe(editor.save()), 2)).toBe("minus100");
    const mod = editor.saveMod();
    expect(mod.changes.backdrop).toEqual([{ episode: 2, rule: "minus100" }]);
    expect(firstDifference(applyMod(game.image, parseMod(modJson(mod))), editor.save())).toBe(-1);
    expect(new Editor(game, mod).backdropRule(2)).toBe("minus100");
    editor.undo();
    expect(editor.backdropOf(2, editor.room(2, 244))?.id).toBe(44);
    expect(editor.saveMod().changes.backdrop).toEqual([]);
    expect(() => editor.setRucksack(3, 41, 251)).toThrow(RangeError);
  });
});

describe("Editor and the dealer", () => {
  const original = defined(readDealer(game.image, 1), "episode I's dealer");
  const cheaper = { goods: original.goods.with(0, { classId: 0x20, state: 0, price: 1 }), most: 6 };

  test("the dealer's goods change as one step, saved into the exe and undone", () => {
    const editor = new Editor(game);
    expect(editor.dealer(1)).toEqual(original);
    expect(editor.dealer(3)).toBeUndefined();
    expect(editor.dealerCapacity(1)).toBe(27);
    const edit = editor.setDealer(1, 43, cheaper);
    expect(edit?.room).toBe(43);
    expect(editor.dirty).toBe(true);
    expect(editor.isDealerEdited(1)).toBe(true);
    // the same again is no edit
    expect(editor.setDealer(1, 43, cheaper)).toBeUndefined();
    expect(readDealer(parsePe(editor.save()), 1)).toEqual(cheaper);
    expect(editor.dirty).toBe(false);
    editor.undo();
    expect(editor.dealer(1)).toEqual(original);
    expect(editor.isDealerEdited(1)).toBe(false);
    editor.redo();
    expect(editor.dealer(1)).toEqual(cheaper);
  });

  test("goods the table cannot hold are refused", () => {
    const editor = new Editor(game);
    const tooMany = { goods: [...original.goods, original.goods[0]], most: 8 };
    expect(editor.dealerProblem(1, tooMany)).toMatch(/at most 27/);
    expect(() => editor.setDealer(1, 43, tooMany)).toThrow(RangeError);
    expect(() => editor.setDealer(3, 41, cheaper)).toThrow(/no dealer/);
    expect(editor.canUndo).toBe(false);
  });

  test("a mod's dealer is where editing starts; saved as the difference to the base", () => {
    const editor = new Editor(game);
    editor.setDealer(1, 43, cheaper);
    const mod = editor.saveMod();
    expect(mod.changes.dealer).toEqual([{ episode: 1, ...cheaper }]);
    sameExe(new Game(applyMod(game.image, parseMod(modJson(mod)))), new Game(editor.save()));
    const opened = new Editor(game, mod);
    expect(opened.dealer(1)).toEqual(cheaper);
    expect(opened.dirty).toBe(false);
    expect(modJson(opened.saveMod())).toBe(modJson(mod));
    // back to the original goods: nothing left to save
    opened.setDealer(1, 43, original);
    expect(opened.saveMod().changes.dealer).toEqual([]);
  });

  function sameExe(a: Game, b: Game): void {
    expect(readDealer(a.image, 1)).toEqual(readDealer(b.image, 1));
    expect(firstDifference(a.image.data, b.image.data)).toBe(-1);
  }
});
