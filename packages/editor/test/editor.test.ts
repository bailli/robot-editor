import { describe, expect, test } from "vitest";

import { Game, LOGIC_CELL } from "@robot/formats";

import { Editor, tilesOf } from "../src/editor.ts";
import { firstDifference, loadGame } from "./game.ts";

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
