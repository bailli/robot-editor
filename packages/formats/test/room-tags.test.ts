import { expect, test } from "vitest";

import { EPISODES, Game } from "../src/game.ts";
import { RoomFlag, roomSaveTime, roomSettings, withRoomSettings } from "../src/room-tags.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("settings are written back like the original scenes keep them", () => {
  for (const episode of EPISODES) {
    for (const room of game.episode(episode).rooms) {
      expect(withRoomSettings(room, roomSettings(room)).tags).toEqual(room.tags);
    }
  }
});

test("episode I room 42: darkness and points for the first visit", () => {
  const room = game.room(1, 42);
  expect(roomSettings(room)).toEqual({ darkness: 80, points: 1000, music: "", flags: 0 });
});

test("the original editor's save time", () => {
  expect(roomSaveTime(game.room(0, game.episode(0).rooms[0]?.id ?? 0))?.toISOString()).toBe(
    "1993-07-15T20:05:27.000Z",
  );
  expect(roomSaveTime({ ...game.room(1, 42), tags: [] })).toBeUndefined();
});

test("new tags go in kind order, settings of 0 remove theirs", () => {
  const room = game.room(1, 42); // tags 2, 4, 6, 6, 6
  const kinds = (r: typeof room) => r.tags.map((t) => t.kind);
  const set = withRoomSettings(room, { music: "LAVA", flags: RoomFlag.DIZZY });
  expect(kinds(set)).toEqual([2, 3, 4, 5, 6, 6, 6]);
  expect(roomSettings(set)).toMatchObject({ music: "LAVA", flags: 2 });
  expect(Array.from(set.tags[3]?.data ?? [])).toEqual([76, 65, 86, 65, 0, 0, 0, 0]);
  const cleared = withRoomSettings(set, { darkness: 0, points: 0, music: "", flags: 0 });
  expect(kinds(cleared)).toEqual([6, 6, 6]);
  expect(roomSettings(cleared)).toEqual({ darkness: 0, points: 0, music: "", flags: 0 });
  expect(room.tags.map((t) => t.kind)).toEqual([2, 4, 6, 6, 6]); // the room stays as it was
});

test("values the tags cannot hold are refused", () => {
  const room = game.room(1, 42);
  expect(() => withRoomSettings(room, { darkness: 101 })).toThrow(RangeError);
  expect(() => withRoomSettings(room, { points: 15 })).toThrow(RangeError);
  expect(() => withRoomSettings(room, { points: 40960 })).toThrow(RangeError);
  expect(withRoomSettings(room, { points: 40950 }).tags).toContainEqual({ kind: 4, value: 4095 });
  expect(() => withRoomSettings(room, { music: "NINECHARS" })).toThrow(RangeError);
  expect(() => withRoomSettings(room, { flags: 256 })).toThrow(RangeError);
});
