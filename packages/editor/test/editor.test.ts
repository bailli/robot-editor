import { describe, expect, test } from "vitest";

import { Game, LOGIC_CELL, compileScript, roomCompiledScript, roomScript } from "@robot/formats";

import { Editor, MAX_RECORD_SLOTS, shownCell, tilesOf } from "../src/editor.ts";
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
    expect(editor.addRecord(1, 43, "overlay", free, 5)).toBe(lowest);
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
