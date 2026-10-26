import { expect, test } from "vitest";

import { noteText } from "@robot/formats";

import { TileNames } from "../src/tile-info.ts";
import { loadGame } from "./game.ts";

const game = await loadGame();

test("a note's line shows its text without the game's colour codes and line breaks", () => {
  const checked = [];
  for (const episode of [1, 2, 3, 4]) {
    const names = new TileNames(game, episode);
    const { classes, rooms } = game.episode(episode);
    for (const room of rooms) {
      for (const cell of [...room.base, ...room.overlay]) {
        if (!noteText(cell, classes)) continue;
        const nodes = names.summaryNodes(cell, room, () => document.createElement("span"));
        const text = nodes.map((n) => n.textContent).join("");
        expect(text, text).not.toMatch(/²|\\|\n/);
        checked.push(cell);
      }
    }
  }
  expect(checked.length).toBeGreaterThan(0);
});
