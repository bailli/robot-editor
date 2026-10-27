import { expect, test } from "vitest";

import { MAX_SHOWN, dealerCapacity, dealerProblem, readDealer, withDealer } from "../src/dealer.ts";
import { EPISODES, Game } from "../src/game.ts";
import { readVa } from "../src/pe.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("the dealer's goods: table, count and most shown per episode", () => {
  const dealers = EPISODES.map((e) => readDealer(game.image, e));
  expect(dealers.map((d) => d?.goods.length)).toEqual([19, 27, 31, undefined, 18]);
  expect(dealers.map((d) => d?.most)).toEqual([8, 10, 8, undefined, 8]);
  expect(EPISODES.map((e) => dealerCapacity(game.image, e))).toEqual([19, 27, 31, 0, 18]);
  // all four sell the SLING for 14 gold first and the SUIT (55 in Junior, else 85)
  for (const dealer of dealers.filter((d) => d !== undefined)) {
    expect(dealer.goods[0]).toEqual({ tile: 0x0020, price: 14 });
  }
  expect(dealers[0]?.goods.find((g) => g.tile === 0x0028)?.price).toBe(55);
  // II: tile 0x6d with state 0x71, GIFT (0x5e) with state 8
  expect(dealers[2]?.goods.slice(-4)).toEqual([
    { tile: 0x716d, price: 30 },
    { tile: 0x0268, price: 3 },
    { tile: 0x0080, price: 17 },
    { tile: 0x085e, price: 25 },
  ]);
});

test("withDealer writes the goods, their number and the most shown", () => {
  const before = readDealer(game.image, 4);
  expect(before).toBeDefined();
  const goods = [...(before?.goods ?? [])].reverse().slice(0, 7);
  const dealer = { goods: goods.with(2, { tile: 0x0315, price: 1234 }), most: 7 };
  const patched = new Game(withDealer(game.image, 4, dealer));
  expect(readDealer(patched.image, 4)).toEqual(dealer);
  // the table keeps its room: grown back to all entries later
  expect(dealerCapacity(patched.image, 4)).toBe(18);
  const all = { goods: before?.goods ?? [], most: 8 };
  expect(readDealer(new Game(withDealer(patched.image, 4, all)).image, 4)).toEqual(all);
  // only I's method and table change
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
    [1, { goods: goods.with(0, { tile: 0, price: 1 }), most: 8 }],
    [1, { goods: goods.with(0, { tile: 0x20, price: 0x8000 }), most: 8 }],
  ] as const;
  for (const [episode, dealer] of problems) {
    expect(() => withDealer(game.image, episode, dealer)).toThrow(RangeError);
  }
  expect(dealerProblem({ goods, most: 8 }, 27)).toBeUndefined();
  expect(dealerProblem({ goods, most: 8 }, 26)).toMatch(/at most 26/);
});
