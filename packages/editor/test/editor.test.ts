import { describe, expect, test } from "vitest";

import {
  Game,
  LOGIC_CELL,
  type Mod,
  NO_CHANGES,
  ROOM_CELLS,
  applyMod,
  compileScript,
  emptyMod,
  findResource,
  modJson,
  parseMod,
  parsePe,
  readEpisodeStart,
  roomCompiledScript,
  roomScript,
  roomSettings,
  serializeRoom,
  sha256,
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
    expect(readEpisodeStart(editor.game.image, 3)).toEqual({ room: 41, x: 2, y: 16 });
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

  test("a mod for another exe is refused", () => {
    const editor = new Editor(game);
    paint(editor, free, 0x0105);
    expect(() => new Editor(new Game(editor.save()), aMod())).toThrow(/for another exe/);
  });
});
