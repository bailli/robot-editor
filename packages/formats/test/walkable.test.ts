import { expect, test } from "vitest";

import { readEpisodeFlags } from "../src/episode-flags.ts";
import { EPISODES, Game } from "../src/game.ts";
import { LOGIC_CELL, type LogicRecord, ROOM_CELLS, type Room } from "../src/scene.ts";
import { type HeroStep, heroSteps } from "../src/walkable.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

const WALL = 0x06;
const WOODS = 0x4c;
const HOUSE = 0x53;
const GOLD = 0x0a;

/** How one cell takes the hero in an otherwise empty room `id` of the episode. */
function step(
  episode: number,
  base: number,
  overlay = 0,
  records: LogicRecord[] = [],
  id = 55,
): HeroStep | undefined {
  const room: Room = {
    id,
    tags: [],
    base: new Uint16Array(ROOM_CELLS).fill(0),
    overlay: new Uint16Array(ROOM_CELLS).fill(0),
    records,
    trailing: new Uint8Array(),
  };
  room.base[0] = base;
  room.overlay[0] = overlay;
  const flags = readEpisodeFlags(game.image, episode);
  return heroSteps(room, game.episode(episode).classes, flags)[0];
}

const record = (slot: number, ...bytes: number[]): LogicRecord => {
  const data = new Uint8Array(10);
  data.set(bytes);
  return { slot, data };
};

test("every class's touch method dispatches by the actor's kind", () => {
  for (const episode of EPISODES) {
    for (const cls of game.episode(episode).classes.classes.values()) {
      expect(cls.heroTouch).toBeDefined();
    }
  }
});

test("tile type 0 and floors take the hero, walls do not", () => {
  expect(step(2, 0)).toBe("walk");
  expect(step(2, WALL)).toBe("block");
  // tiles that turn into actors on entering leave the cell empty
  expect(step(2, 0x02)).toBe("walk");
});

test("woods: states 4 and 5 need the cutting tool, 10 only where flag 0x20000 is set", () => {
  expect(step(2, WOODS)).toBe("block");
  expect(step(2, WOODS | (4 << 8))).toBe("depends");
  expect(step(2, WOODS | (5 << 8))).toBe("depends");
  expect(step(2, WOODS | (10 << 8))).toBe("block");
  expect(step(3, WOODS | (10 << 8))).toBe("depends");
});

test("house cells: from state 9 on he walks on, in III's rooms from 100 on not", () => {
  expect(step(2, HOUSE)).toBe("block");
  expect(step(2, HOUSE | (9 << 8))).toBe("walk");
  expect(step(2, HOUSE | (6 << 8))).toBe("depends"); // a door in
  expect(step(3, HOUSE | (10 << 8), 0, [], 114)).toBe("block");
  expect(step(3, HOUSE | (10 << 8), 0, [], 41)).toBe("walk");
});

test("an overlay object is asked first, then the cell under it", () => {
  expect(step(2, 0, GOLD)).toBe(step(2, GOLD));
  expect(step(2, WALL, GOLD)).toBe("block");
  expect(step(2, 0, WALL)).toBe("block");
  expect(step(2, WOODS | (4 << 8), 0)).toBe("depends");
  // an overlay logic cell is dropped on entering
  expect(step(2, 0, LOGIC_CELL)).toBe("walk");
});

test("teleporters: a condition depends on what he carries, bit 0 always lets him on", () => {
  const logic = LOGIC_CELL | (1 << 8);
  expect(step(2, logic, 0, [record(1, 13, 0, WALL, 0, 0, 0, 0, 1)])).toBe("depends");
  expect(step(2, logic, 0, [record(1, 13, 0, WALL, 0, 0, 0, 0, 2)])).toBe("depends");
  expect(step(2, logic, 0, [record(1, 13, 1, WALL)])).toBe("walk");
  // without either the cell it shows decides
  expect(step(2, logic, 0, [record(1, 13, 0, WALL)])).toBe("block");
  expect(step(2, logic, 0, [record(1, 13, 0, 0)])).toBe("walk");
  // as for other records; a missing record shows an empty cell
  expect(step(2, logic, 0, [record(1, 12, 0, WALL)])).toBe("block");
  expect(step(2, logic)).toBe("walk");
});

test("sand from state 8 on blocks; water: never in Junior, in III with state bit 0x10", () => {
  const SAND = 0x31;
  const WATER = 0x12;
  expect(step(2, SAND | (7 << 8))).toBe("walk"); // a heap: a scorpion comes out
  expect(step(2, SAND | (8 << 8))).toBe("block");
  expect(step(0, WATER)).toBe("block");
  expect(step(2, WATER)).toBe("walk");
  expect(step(3, WATER)).toBe("block");
  expect(step(3, WATER | (0x10 << 8))).toBe("walk");
});

test("how the originals' cells take the hero, per episode", () => {
  const counts = EPISODES.map((episode) => {
    const { rooms, classes } = game.episode(episode);
    const flags = readEpisodeFlags(game.image, episode);
    const count: Record<HeroStep, number> = { walk: 0, block: 0, depends: 0 };
    for (const room of rooms) for (const s of heroSteps(room, classes, flags)) count[s]++;
    return count;
  });
  expect(counts).toMatchSnapshot();
});
