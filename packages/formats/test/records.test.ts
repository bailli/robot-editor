import { expect, test } from "vitest";

import { EPISODES, Game } from "../src/game.ts";
import { describeRecord } from "../src/records.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

const summary = (episode: number, room: number, type: number) => {
  const record = game.room(episode, room).records.find((r) => r.data[0] === type);
  return record && describeRecord(record, game.episode(episode).classes).summary;
};

test("every logic record in the game has a known type", () => {
  const kinds = new Map<string, number>();
  for (const episode of EPISODES) {
    for (const room of game.episode(episode).rooms) {
      for (const record of room.records) {
        const { kind } = describeRecord(record);
        kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
      }
    }
  }
  expect(kinds.has("unknown")).toBe(false);
  expect(Object.fromEntries([...kinds].sort())).toMatchSnapshot();
});

test("records say what they do", () => {
  expect(summary(4, 44, 1)).toBe("0x016c lies on 0x906c"); // a drawbridge
  expect(summary(0, 31, 8)).toBe(
    "the dealer appears here; once the hero dealt with it, it leaves through an edge wall, " +
      "and following it leads to room 41 at (14, 3)",
  );
  expect(summary(1, 126, 8)).toMatch(/^the thief appears here/);
  expect(summary(2, 55, 13)).toBe("a teleporter to room 155 at (6, 7)");
  expect(summary(3, 11, 3)).toMatch(/^0x\w{4} is buried under 0x\w{4}; dig to find it$/);
  expect(summary(3, 11, 5)).toMatch(/^a robot appears every \d+ ticks while the hero is within /);
});
