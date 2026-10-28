import { expect, test } from "vitest";

import { readEpisodeClasses } from "../src/classes.ts";
import {
  type BackdropRule,
  backdropRoomId,
  readBackdropRule,
  readDiagonalMoves,
  withBackdropRule,
  withDiagonalMoves,
} from "../src/episode-methods.ts";
import { EPISODE_VTABLES, fileOffset } from "../src/episode.ts";
import { EPISODES, Game } from "../src/game.ts";
import { parsePe } from "../src/pe.ts";
import { backdropRoom } from "../src/render.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("the episodes' backdrop rules: mod 100 in Junior to III, minus 100 in IV", () => {
  expect(EPISODES.map((e) => readBackdropRule(game.image, e))).toEqual([
    "mod100",
    "mod100",
    "mod100",
    "mod100",
    "minus100",
  ]);
  expect([backdropRoomId("mod100", 242), backdropRoomId("minus100", 242)]).toEqual([42, 142]);
});

test("the rule changes in the vtable only; the renderer follows the exe", () => {
  const patched = parsePe(withBackdropRule(game.image, 2, "minus100"));
  expect(readBackdropRule(patched, 2)).toBe("minus100");
  const changed = patched.data.reduce((n, b, i) => n + Number(b !== game.image.data[i]), 0);
  expect(changed).toBeGreaterThan(0);
  expect(changed).toBeLessThanOrEqual(8);
  // II's 244 over 144 (STATUS: the floor above an interior) shows 44 by mod 100, 144 by -100
  const room = { ...game.room(2, 115), id: 244 };
  const rooms = game.episode(2).rooms;
  expect(backdropRoom(room, rooms, game.episode(2).classes)?.id).toBe(44);
  expect(backdropRoom(room, rooms, readEpisodeClasses(patched, 2))?.id).toBe(144);
});

test("an unknown pair of backdrop methods leaves the episode loading, drawing no backdrop", () => {
  // what a `code` change can leave in the vtable: neither pair
  const odd = game.image.data.slice();
  const at = fileOffset(game.image, EPISODE_VTABLES[2] ?? 0, 8);
  new DataView(odd.buffer).setUint32(at, 0x401000, true);
  const image = parsePe(odd);
  expect(readBackdropRule(image, 2)).toBeUndefined();
  const classes = new Game(odd).episode(2).classes;
  expect(classes.backdropRule).toBeUndefined();
  const room = { ...game.room(2, 115), id: 244 };
  expect(backdropRoom(room, game.episode(2).rooms, classes)).toBeUndefined();
});

test("diagonal moves: only III and IV; switched in the vtable", () => {
  expect(EPISODES.map((e) => readDiagonalMoves(game.image, e))).toEqual([
    false,
    false,
    false,
    true,
    true,
  ]);
  const patched = parsePe(withDiagonalMoves(game.image, 0, true));
  expect(readDiagonalMoves(patched, 0)).toBe(true);
  expect(readDiagonalMoves(parsePe(withDiagonalMoves(patched, 0, false)), 0)).toBe(false);
  const changed = patched.data.reduce((n, b, i) => n + Number(b !== game.image.data[i]), 0);
  expect(changed).toBeLessThanOrEqual(4);
});

test("withBackdropRule throws a RangeError for an unknown rule", () => {
  expect(() => withBackdropRule(game.image, 2, "nope" as BackdropRule)).toThrow(RangeError);
});
