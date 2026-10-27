import { expect, test } from "vitest";

import {
  MAX_SHOWN,
  cellGood,
  dealerCapacity,
  dealerProblem,
  goodTile,
  readDealer,
  withDealer,
} from "../src/dealer.ts";
import { EPISODES, Game } from "../src/game.ts";
import { readVa } from "../src/pe.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

/** The goods as the game names their tiles (object names; unnamed: the tile type). */
function names(episode: number): string[] {
  const { classes } = game.episode(episode);
  const objects = game.objectNames(episode);
  return (readDealer(game.image, episode)?.goods ?? []).map((good) => {
    const tile = goodTile(good, classes) ?? 0;
    return objects.get(tile & 0xff) ?? `0x${(tile & 0xff).toString(16)}`;
  });
}

test("the dealer's goods: classes, count and most shown per episode", () => {
  const dealers = EPISODES.map((e) => readDealer(game.image, e));
  expect(dealers.map((d) => d?.goods.length)).toEqual([19, 27, 31, undefined, 18]);
  expect(dealers.map((d) => d?.most)).toEqual([8, 10, 8, undefined, 8]);
  expect(EPISODES.map((e) => dealerCapacity(game.image, e))).toEqual([19, 27, 31, 0, 18]);
  // all four sell the SLING for 14 gold first
  for (const dealer of dealers.filter((d) => d !== undefined)) {
    expect(dealer.goods[0]).toEqual({ classId: 0x20, state: 0, price: 14 });
  }
  // the entries are classes: in episode I class 0x25 is the TONIC (tile 0x33), class
  // 0x40 a BARRIER (tile 0x40 would be the thief), in II class 0x66 FOOD (not fire)
  expect(names(1).slice(14)).toEqual([
    "TONIC",
    "SICKLE",
    "SAVE",
    "0x39",
    "NOTE",
    "BARRIER",
    "0x12",
    "KEY",
    "KEY",
    "KEY",
    "KEY",
    "KEY",
    "LAMP",
  ]);
  expect(names(2).slice(-6)).toEqual(["FOOD", "FOOD", "GIFT", "MONEY", "KOMPASS", "AMMUL"]);
  // a package keeps its contents' class, shown as their tile type (0x448565)
  const gift = dealers[2]?.goods.at(-4);
  expect(gift).toEqual({ classId: 0x6d, state: 0x71, price: 30 });
  const { classes } = game.episode(2);
  const tile = goodTile(gift ?? { classId: 0, state: 0 }, classes);
  expect(tile).toBe(0x625e);
  expect(cellGood(tile ?? 0, classes)).toEqual({ classId: 0x6d, state: 0x71 });
  // a key keeps its state; a tile without a class cannot be sold
  expect(cellGood(0x0315, classes)).toEqual({ classId: 0x15, state: 3 });
  expect(cellGood(0, classes)).toBeUndefined();
});

test("withDealer writes the goods, their number and the most shown", () => {
  const before = readDealer(game.image, 4);
  expect(before).toBeDefined();
  const goods = [...(before?.goods ?? [])].reverse().slice(0, 7);
  const dealer = { goods: goods.with(2, { classId: 0x15, state: 3, price: 1234 }), most: 7 };
  const patched = new Game(withDealer(game.image, 4, dealer));
  expect(readDealer(patched.image, 4)).toEqual(dealer);
  // the table keeps its room: grown back to all entries later
  expect(dealerCapacity(patched.image, 4)).toBe(18);
  const all = { goods: before?.goods ?? [], most: 8 };
  expect(readDealer(new Game(withDealer(patched.image, 4, all)).image, 4)).toEqual(all);
  // only IV's method and table change
  for (const e of [0, 1, 2, 3]) {
    expect(readDealer(patched.image, e)).toEqual(readDealer(game.image, e));
  }
  expect(readVa(patched.image, 0x478bf8 + 18 * 4, 16)).toEqual(
    readVa(game.image, 0x478bf8 + 18 * 4, 16),
  );
});

test("goods the game cannot take are refused", () => {
  const goods = readDealer(game.image, 1)?.goods ?? [];
  const problems = [
    [3, { goods, most: 8 }],
    [1, { goods: [...goods, goods[0]], most: 8 }],
    [1, { goods: goods.slice(0, 4), most: 4 }],
    [1, { goods: goods.slice(0, 6), most: 7 }],
    [1, { goods, most: MAX_SHOWN + 1 }],
    [1, { goods: goods.with(0, { classId: 0, state: 0, price: 1 }), most: 8 }],
    [1, { goods: goods.with(0, { classId: 0x100, state: 0, price: 1 }), most: 8 }],
    [1, { goods: goods.with(0, { classId: 0x20, state: 0, price: 0x8000 }), most: 8 }],
  ] as const;
  for (const [episode, dealer] of problems) {
    expect(() => withDealer(game.image, episode, dealer)).toThrow(RangeError);
  }
  expect(dealerProblem({ goods, most: 8 }, 27)).toBeUndefined();
  expect(dealerProblem({ goods, most: 8 }, 26)).toMatch(/at most 26/);
  // with the episode's classes: a class it has no tile of
  const { classes } = game.episode(1);
  const unknown = goods.with(0, { classId: 0xfe, state: 0, price: 1 });
  expect(dealerProblem({ goods: unknown, most: 8 }, 27)).toBeUndefined();
  expect(dealerProblem({ goods: unknown, most: 8 }, 27, classes)).toMatch(/no tile of class 0xfe/);
});
