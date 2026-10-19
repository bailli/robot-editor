import assert from "node:assert/strict";

import { expect, test } from "vitest";

import {
  describeCell,
  descriptionTexts,
  knowsDescribeMethod,
  requiredPoints,
} from "../src/describe.ts";
import { EPISODES, Game } from "../src/game.ts";
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
