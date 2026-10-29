import assert from "node:assert/strict";

import { expect, test } from "vitest";

import {
  cellData,
  describeCell,
  descriptionTexts,
  knowsDescribeMethod,
  noteText,
  packageContents,
  requiredPoints,
  withCellData,
} from "../src/describe.ts";
import { EPISODES, Game, roomNamesId } from "../src/game.ts";
import { displayText } from "../src/texts.ts";
import { exe, snapshot } from "./data.ts";

const game = new Game(exe());

function says(episode: number, cell: number, roomId?: number): string[] {
  const { classes } = game.episode(episode);
  const room = roomId === undefined ? undefined : game.room(episode, roomId);
  const description = describeCell(cell, classes, episode, room);
  assert.ok(description, `no description for ${cell.toString(16)}`);
  return descriptionTexts(description, game.episodeTexts(episode)?.entries ?? new Map()).map((t) =>
    displayText(t),
  );
}

test("every class's describe method is known", () => {
  for (const episode of EPISODES) {
    for (const [type, cls] of game.episode(episode).classes.classes) {
      const where = `episode ${episode} type ${type}`;
      assert.ok(
        knowsDescribeMethod(cls.describeMethod),
        `${where}: ${cls.describeMethod.toString(16)}`,
      );
      assert.ok(describeCell(type, game.episode(episode).classes, episode), where);
    }
  }
});

test("the variant follows the cell's state", () => {
  expect(says(3, 0x0053)).toEqual(["Dies ist schlicht ein Teil des Daches!"]);
  expect(says(3, 0x0753)).toEqual(["Richtig, das sind Eingänge zum Haus."]);
  expect(says(3, 0x0853)).toEqual(["Der Schornstein!"]);
  expect(says(3, 0x003d)).toEqual(["Diese Treppen führen hinunter."]);
  expect(says(3, 0x013d)).toEqual(["Diese Treppen führen hinauf."]);
});

test("most tiles pick one of their variants at random", () => {
  expect(says(3, 0x0000)).toHaveLength(4); // "Hier gibt's nichts Interessantes zu sehen." ...
});

test("logic cells are described by their records", () => {
  const room = game.room(2, 55);
  const slot = room.records.findIndex((r) => r.data[0] === 13);
  const teleporter = room.records[slot];
  assert.ok(teleporter);
  expect(says(2, 0x7f | (teleporter.slot << 8), 55)).toHaveLength(1);
});

test("descriptions of every cell in the game", () => {
  for (const episode of EPISODES) {
    const { rooms, classes } = game.episode(episode);
    const texts = game.episodeTexts(episode)?.entries ?? new Map<number, string[]>();
    const lines: string[] = [];
    for (const room of rooms) {
      for (const cell of new Set([...room.base, ...room.overlay])) {
        const d = describeCell(cell, classes, episode, room);
        if (d) lines.push(`${cell.toString(16)}: ${descriptionTexts(d, texts).join(" | ")}`);
      }
    }
    snapshot(`episode ${episode}`, [...new Set(lines)].sort());
  }
});

test("expert fields need their state × 10,000 points", () => {
  const classes = game.episode(1).classes;
  expect(requiredPoints(0x0c32, classes)).toBe(120000);
  expect(requiredPoints(0x1a32, classes)).toBe(260000);
  expect(requiredPoints(0x0c31, classes)).toBeUndefined();
  // Junior's tile 0x32 is the goal, not an expert field
  expect(requiredPoints(0x0132, game.episode(0).classes)).toBeUndefined();
});

/** The title screen, episode IV's sheet of all tiles and the debug room. */
const notPlayed = (episode: number, room: number) =>
  room === 1 || room === 99 || (episode === 4 && room === 2);

test("every note and diary page has its text", () => {
  for (const episode of EPISODES) {
    const { rooms, classes } = game.episode(episode);
    const texts = game.episodeTexts(episode)?.entries;
    const pages = game.texts(roomNamesId(episode))?.entries;
    for (const room of rooms) {
      if (notPlayed(episode, room.id)) continue;
      for (const cell of new Set([...room.base, ...room.overlay])) {
        const note = noteText(cell, classes);
        if (!note) continue;
        const where = `episode ${episode} room ${room.id} cell ${cell.toString(16)}`;
        assert.ok((note.read === "diary" ? pages : texts)?.has(note.text), where);
      }
    }
  }
  expect(noteText(0x8e0f, game.episode(0).classes)).toEqual({ text: 814, read: "step" });
  expect(noteText(0x0c3a, game.episode(4).classes)).toEqual({ text: 812, read: "carry" });
  expect(noteText(0x043a, game.episode(3).classes)).toEqual({ text: 4, read: "diary" });
  expect(noteText(0x043b, game.episode(3).classes)).toBeUndefined();
});

test("packages hold the tile type in their state", () => {
  expect(packageContents(0x695e, game.episode(3).classes)).toBe(0x69); // a shovel
  expect(packageContents(0x025e, game.episode(2).classes)).toBe(2); // a robot
  expect(packageContents(0x0c3a, game.episode(4).classes)).toBeUndefined();
  for (const episode of EPISODES) {
    const { rooms, classes } = game.episode(episode);
    for (const room of rooms) {
      if (notPlayed(episode, room.id)) continue;
      for (const cell of new Set([...room.base, ...room.overlay])) {
        const type = packageContents(cell, classes);
        if (type !== undefined) assert.ok(classes.classes.get(type)?.id, `${episode}: ${type}`);
      }
    }
  }
});

test("the data a cell keeps in its state", () => {
  expect(cellData(0x695e, game.episode(3).classes)).toEqual({ kind: "package", type: 0x69 });
  expect(cellData(0x8e0f, game.episode(0).classes)).toEqual({
    kind: "note",
    message: 814,
    read: "step",
  });
  expect(cellData(0x043a, game.episode(3).classes)).toEqual({ kind: "diary", page: 4 });
  expect(cellData(0x0c32, game.episode(1).classes)).toEqual({ kind: "expert", points: 120000 });
  expect(cellData(0x4125, game.episode(1).classes)).toEqual({ kind: "letter", code: 0x41 });
  expect(cellData(0x0132, game.episode(0).classes)).toBeUndefined();
  // every cell of the game reads back as it was
  for (const episode of EPISODES) {
    const { rooms, classes } = game.episode(episode);
    for (const room of rooms) {
      for (const cell of new Set([...room.base, ...room.overlay])) {
        const data = cellData(cell, classes);
        if (data) expect(withCellData(cell, data, classes)).toBe(cell);
      }
    }
  }
});

test("data is written into the state", () => {
  const ii = game.episode(2).classes;
  expect(withCellData(0x025e, { kind: "package", type: 0x13 }, ii)).toBe(0x135e);
  expect(withCellData(0x013a, { kind: "note", message: 927, read: "step" }, ii)).toBe(0xff3a);
  expect(withCellData(0x8f3a, { kind: "note", message: 800, read: "carry" }, ii)).toBe(0x003a);
  expect(withCellData(0x0132, { kind: "expert", points: 2550000 }, ii)).toBe(0xff32);
  expect(withCellData(0x4125, { kind: "letter", code: 0x3f }, ii)).toBe(0x3f25);
  const iii = game.episode(3).classes;
  expect(withCellData(0x043a, { kind: "diary", page: 0x92 }, iii)).toBe(0x923a);
});

test("data no state can hold is refused", () => {
  const ii = game.episode(2).classes;
  const refused = (cell: number, data: Parameters<typeof withCellData>[1]) => {
    expect(() => withCellData(cell, data, ii)).toThrow(RangeError);
  };
  refused(0x013a, { kind: "note", message: 799, read: "carry" });
  refused(0x013a, { kind: "note", message: 928, read: "carry" });
  refused(0x0132, { kind: "expert", points: 15000 });
  refused(0x0132, { kind: "expert", points: 2560000 });
  refused(0x025e, { kind: "package", type: 0x100 });
  refused(0x4125, { kind: "letter", code: -1 });
  // the class keeps other data, or none
  refused(0x025e, { kind: "expert", points: 10000 });
  refused(0x0000, { kind: "letter", code: 0x41 });
});
