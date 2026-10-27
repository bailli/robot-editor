import assert from "node:assert/strict";

import { expect, test } from "vitest";

import {
  ACTOR_CLASS_NAMES,
  type ScriptActors,
  randomPlacement,
  recordActorKind,
  robotSprite,
  robotSpriteCount,
  roomActors,
  scriptActors,
} from "../src/actors.ts";
import { roomScript } from "../src/exits.ts";
import { EPISODES, Game } from "../src/game.ts";
import { ROOM_WIDTH, type Room } from "../src/scene.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

const count = (episode: number, room: number) => {
  const counts: Record<string, number> = {};
  for (const a of roomActors(game.room(episode, room), game.episode(episode).classes)) {
    const key = `${a.source} 0x${(a.type ?? 0).toString(16)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

test("the actors of a room: robots, androids, the worm and a bomb", () => {
  expect(count(2, 123)).toEqual({ "tile 0x2": 20, "tile 0x2d": 4, "tile 0x37": 1, "bomb 0x13": 1 });
});

test("records let robots, natives and travelling actors appear", () => {
  const classes = game.episode(4).classes;
  const spawners = roomActors(game.room(4, 341), classes).filter((a) => a.source === "spawner");
  expect(spawners).toHaveLength(8);
  expect(spawners[0]?.type).toBe(2); // episode IV's robots (class 189)
  expect(spawners[0]?.radius).toBeGreaterThan(0);

  const natives = roomActors(game.room(3, 11), game.episode(3).classes).filter(
    (a) => a.source === "creature",
  );
  expect(natives.map((a) => a.type)).toEqual([0x2c, 0x2c, 0x2c]); // "freundliche Eingeborene"

  const travelling = roomActors(game.room(0, 31), game.episode(0).classes).find(
    (a) => a.source === "travelling",
  );
  expect(travelling?.target).toEqual({ room: 41, x: 14, y: 3 });
});

test("travelling actors are the dealer and the thief", () => {
  // byte 8 with bit 0x80 indexes the episode's actor kinds: 0x83 -> 0x103, 0x85 -> 0x105
  expect(game.episode(1).classes.actorKinds).toEqual([0x100, 0x101, 0x102, 0x103, 0x104, 0x105]);
  const classes = game.episode(1).classes;
  expect(recordActorKind(0x83, classes)).toBe(0x103);
  expect(recordActorKind(0x85, classes)).toBe(0x105);
  // without the bit a tile type: tile 0x2c is the dealer's class
  expect(recordActorKind(0x2c, classes)).toBe(0x12c);
  // past the episode's table: no actor
  expect(recordActorKind(0x86, classes)).toBeUndefined();
  const names = EPISODES.flatMap((episode) =>
    game.episode(episode).rooms.flatMap((room) =>
      roomActors(room, game.episode(episode).classes)
        .filter((a) => a.source === "travelling")
        .map((a) => {
          const id = game.episode(episode).classes.classes.get(a.type ?? -1)?.id ?? -1;
          return ACTOR_CLASS_NAMES[id] ?? "?";
        }),
    ),
  );
  expect(names.filter((n) => n === "Dealer").length).toBe(9);
  expect(names.filter((n) => n === "Thief").length).toBe(10);
  expect(names.includes("?")).toBe(false);
});

test("scripts scatter robots, androids and bombs", () => {
  expect(scriptActors(roomScript(game.room(2, 123)))).toEqual([
    { name: "ALIEN", min: 8, max: 15, conditional: true },
    { name: "ANDROID", min: 2, max: 4, conditional: true },
    { name: "BOMB", min: 1, max: 1, conditional: true },
  ]);
});

test("actors in every episode", () => {
  expect(
    EPISODES.map((episode) => {
      const counts: Record<string, number> = {};
      for (const room of game.episode(episode).rooms) {
        for (const a of roomActors(room, game.episode(episode).classes)) {
          counts[a.source] = (counts[a.source] ?? 0) + 1;
        }
      }
      return counts;
    }),
  ).toMatchSnapshot();
});

test("RandObj counts what the room has and places robots away from the hero", () => {
  const room = game.room(2, 123);
  const place = (name: string) => {
    const call = scriptActors(roomScript(room)).find((c) => c.name === name);
    assert.ok(call, name);
    return randomPlacement(call, room, game.episode(2).classes, game.scriptConstants(2));
  };
  expect(place("ALIEN")).toMatchObject({ type: 2, existing: 20, awayFromHero: true });
  expect(place("ANDROID")).toMatchObject({ type: 0x2d, existing: 4, awayFromHero: true });
  expect(place("BOMB")).toMatchObject({ type: 0x13, existing: 1, awayFromHero: false });
  expect(place("ALIEN").free).toBeGreaterThan(100);
});

test("script object names resolve through the sound tables first", () => {
  const room = game.room(1, 35); // RandObj(O_TREE, 1, 1)
  const tree = scriptActors(roomScript(room)).find((c) => c.name === "TREE");
  expect(
    tree && randomPlacement(tree, room, game.episode(1).classes, game.scriptConstants(1)).type,
  ).toBe(11);
});

/** Room `id` of `episode` with cells (x, y) set in a layer and the records it has. */
function edited(
  episode: number,
  id: number,
  cells: readonly (readonly [x: number, y: number, value: number, layer?: "overlay"])[],
): Room {
  const room = game.room(episode, id);
  const copy = { ...room, base: room.base.slice(), overlay: room.overlay.slice() };
  for (const [x, y, value, layer = "base"] of cells) copy[layer][y * ROOM_WIDTH + x] = value;
  return copy;
}

test("robots take their sprite by their place among the actors created on entering", () => {
  // Junior to III keep the last _Aliens sprite for scorpions
  expect(EPISODES.map((e) => robotSpriteCount(e, game.aliens(e).length))).toEqual([7, 7, 7, 7, 5]);
  const classes = game.episode(2).classes;
  const actors = roomActors(game.room(2, 123), classes);
  const created = actors.filter((a) => a.order !== undefined);
  // the game's order: row by row, cell by cell
  expect(created.map((a) => a.order)).toEqual(created.map((_, i) => i));
  expect(created.map((a) => a.cell)).toEqual(created.map((a) => a.cell).sort((a, b) => a - b));
  // the first actor, itself counted, takes sprite 1
  const first = created.at(0);
  assert.ok(first);
  expect(robotSprite(first, 7)).toBe(1);
  // the bomb lets its robots appear later
  expect(actors.find((a) => a.source === "bomb")?.order).toBeUndefined();
});

test("only cells the game loads become actors", () => {
  const classes = game.episode(2).classes;
  const robot = 0x02;
  const at = (room: Room) =>
    roomActors(room, classes)
      .filter((a) => a.source === "tile" && a.cell < 3 * ROOM_WIDTH)
      .map((a) => [a.cell, a.layer]);
  const room = (cells: Parameters<typeof edited>[2]) =>
    edited(2, 123, [
      ...[0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => [x, y, 0] as const)),
      ...cells,
    ]);
  // row 0 lies under the status line
  expect(at(room([[1, 0, robot]]))).toEqual([]);
  // an object that stays hides a robot under it; a robot on a robot: both appear
  expect(
    at(
      room([
        [1, 1, robot],
        [1, 1, 0x0b, "overlay"],
      ]),
    ),
  ).toEqual([]);
  expect(
    at(
      room([
        [1, 1, robot],
        [1, 1, robot, "overlay"],
      ]),
    ),
  ).toEqual([
    [ROOM_WIDTH + 1, "overlay"],
    [ROOM_WIDTH + 1, "base"],
  ]);
});

test("RandObj counts the actors records let appear, by class", () => {
  // episode III room 11: three natives from records (class 0x9f, tile 0x2c); its script
  // names have none, a constant for the tile stands in
  const call: ScriptActors = { name: "NATIVE", min: 0, max: 5, conditional: false };
  const room = game.room(3, 11);
  expect(room.base.filter((v) => (v & 0xff) === 0x2c)).toHaveLength(0);
  const classes = game.episode(3).classes;
  expect(randomPlacement(call, room, classes, new Map([["O_NATIVE", 0x2c]])).existing).toBe(3);
});
