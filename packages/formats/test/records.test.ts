import { expect, test } from "vitest";

import { EPISODES, Game } from "../src/game.ts";
import { describeRecord, readOracleSymbols, teleporterCondition } from "../src/records.ts";
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
  expect(summary(2, 55, 13)).toBe(
    "a teleporter to room 155 at (6, 7); only for a hero who carries an object like 0x0074",
  );
  expect(summary(3, 11, 3)).toMatch(/^0x\w{4} is buried under 0x\w{4}; dig to find it$/);
  expect(summary(3, 11, 5)).toMatch(/^a robot appears every \d+ ticks while the hero is within /);
});

test("teleporters may ask the hero to carry the object they show, or not to", () => {
  const conditions = new Map<string, number>();
  for (const episode of EPISODES) {
    for (const room of game.episode(episode).rooms) {
      for (const record of room.records.filter((r) => r.data[0] === 13)) {
        const condition = teleporterCondition(record.data);
        conditions.set(condition, (conditions.get(condition) ?? 0) + 1);
      }
    }
  }
  expect(Object.fromEntries(conditions)).toEqual({ none: 152, carry: 48, "not carry": 72 });
  const gold = game.room(1, 21).records.find((r) => r.data[0] === 13 && r.data[2] === 0x0a);
  expect(gold && describeRecord(gold).summary).toBe(
    "a teleporter to room 44 at (2, 15); only for a hero who carries no object like 0x000a",
  );
});

test("oracles need their symbol of tangram pieces", () => {
  const symbols = readOracleSymbols(game.image);
  expect(symbols.length).toBe(10);
  // the pattern of oracle 0, tried in the game: three plain pieces and one in state 4
  expect(symbols[0]).toEqual([0, 0, 0, 4]);
  const oracle = game.room(2, 106).records.find((r) => r.data[0] === 12);
  expect(oracle && describeRecord(oracle, undefined, symbols).summary).toBe(
    "an oracle; once its symbol, tangram pieces 0x0450 0x0450 0x0450 0x0450 in a 2×2 block " +
      "(top left to bottom right), lies in the room: walked into northwards it sends to " +
      "room 613 at (36, 2), eastwards it shows message 339, westwards it turns into 0x0c15, " +
      "southwards it kills",
  );
});
