import { describe, expect, test } from "vitest";

import {
  Game,
  LOGIC_CELL,
  ROOM_CELLS,
  compileScript,
  parsePe,
  readEpisodeStart,
  roomCompiledScript,
  roomScript,
} from "@robot/formats";

import { Editor, MAX_RECORD_SLOTS, recordCapacity, shownCell, tilesOf } from "../src/editor.ts";
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

describe("Editor rooms and names", () => {
  test("a copied room is a new room with the same content, undone as one step", () => {
    const editor = new Editor(game);
    const id = defined(editor.freeRoomId(1, 43));
    expect(game.episode(1).rooms.some((r) => r.id === id)).toBe(false);
    expect(editor.addRoom(1, id, 43).added?.id).toBe(id);
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

  test("the test exe starts the episode in the room, with the edits", () => {
    const editor = new Editor(game);
    editor.addRoom(1, 999, 43);
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
    editor.addRoom(3, 250, 41);
    editor.removeRoom(3, 250);
    expect(editor.rooms(3).some((r) => r.id === 250)).toBe(false);
    expect(() => editor.removeRoom(3, 41)).toThrow(RangeError);
    expect(() => editor.removeRoom(3, 1)).toThrow(RangeError);
    expect(() => editor.removeRoom(3, 250)).toThrow();
  });
});
