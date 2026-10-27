import { expect, test } from "vitest";

import { backdropRoomId, readBackdropRule, withBackdropRule } from "../src/backdrop.ts";
import { readEpisodeClasses } from "../src/classes.ts";
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
