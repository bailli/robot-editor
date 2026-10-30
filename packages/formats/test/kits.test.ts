import { expect, test } from "vitest";

import { Game } from "../src/game.ts";
import { KITS, kitChanges, planKit } from "../src/kits.ts";
import { exe } from "./data.ts";

const game = new Game(exe());
const kit = (key: string) => {
  const found = KITS.find((k) => k.key === key);
  if (!found) throw new Error(key);
  return found;
};
const [oracles, circuits] = [kit("oracles"), kit("circuits")];

test("oracles: II's tangram and oracle, their texts; IV's events in its spare entries", () => {
  // Junior has the oracles' events 262-271, not their texts
  expect(planKit(game, 0, oracles)).toEqual({
    types: [
      [0x50, 0x50],
      [0x51, 0x51],
    ],
    present: [],
    texts: [331, 332, 334, 339, 945],
    events: [],
    lacking: [],
    without: [],
    // the tangram's !KLINGELI Junior has
    music: [],
  });
  // II and III have them
  expect(planKit(game, 3, oracles)).toMatchObject({ types: [], present: [0x50, 0x51] });
  // IV lacks all ten events and has four spare entries: the first four, or those chosen
  const iv = planKit(game, 4, oracles);
  expect(iv.types).toEqual([
    [0x48, 0x50],
    [0x6d, 0x51],
  ]);
  expect(iv.events.map((e) => [e.entry, e.id])).toEqual([
    [197, 262],
    [198, 263],
    [199, 264],
    [200, 265],
  ]);
  expect(iv.without).toEqual([266, 267, 268, 269, 270, 271]);
  expect(iv.music).toEqual(["ORACLE"]);
  const chosen = planKit(game, 4, oracles, { events: [263, 266] });
  // as the game test's mod, which gave 3500 points and II's texts under Wine; IV lacks
  // the events' piece, which comes along
  expect(kitChanges(game, 4, oracles, chosen)).toEqual({
    music: [{ episode: 4, from: 2, pieces: ["ORACLE"] }],
    tileTypes: [
      {
        episode: 4,
        from: 2,
        types: [
          [0x48, 0x50],
          [0x6d, 0x51],
        ],
      },
    ],
    events: [
      { episode: 4, entry: 197, id: 263, points: 3500, sound: "!ORACLE" },
      { episode: 4, entry: 198, id: 266, points: 3500, sound: "!ORACLE" },
    ],
    copyTexts: [
      {
        resource: 1410,
        from: 1210,
        entries: [
          [331, 331],
          [332, 332],
          [334, 334],
          [339, 339],
          [945, 945],
          [1997, 1935],
          [1998, 1938],
        ],
      },
    ],
  });
  expect(planKit(game, 4, oracles, { events: [262, 263, 264, 265, 266] }).problem).toMatch(
    /5 events chosen, 4 spare entries left/,
  );
  expect(planKit(game, 0, oracles, { events: [262] }).problem).toMatch(/has event 262 already/);
});

test("circuits: I's pieces, stairs only where the episode has none; event 293 where it fits", () => {
  expect(planKit(game, 0, circuits).types).toEqual([
    [0x3a, 0x25],
    [0x42, 0x42],
    [0x43, 0x43],
    [0x3d, 0x3d],
  ]);
  // III has stairs and no spare entry: its nodes give no points
  expect(planKit(game, 3, circuits)).toMatchObject({
    types: [
      [0x0e, 0x25],
      [0x0f, 0x42],
      [0x43, 0x43],
    ],
    present: [0x3d],
    events: [],
    without: [293],
  });
  const iv = planKit(game, 4, circuits);
  expect(kitChanges(game, 4, circuits, iv)).toMatchObject({
    // the gate's and bulb's FANFA2 and the lit node's BULBON, which IV lacks
    music: [{ episode: 4, from: 1, pieces: ["FANFA2", "BULBON"] }],
    events: [{ episode: 4, entry: 197, id: 293, points: 4000, sound: "!BULBON" }],
  });
  expect(kitChanges(game, 3, circuits, planKit(game, 3, circuits)).music).toEqual([
    { episode: 3, from: 1, pieces: ["FANFA2"] },
  ]);
  // I and II have circuits
  for (const e of [1, 2]) expect(planKit(game, e, circuits).types).toEqual([]);
  // too few free types
  expect(planKit(game, 0, circuits, { free: [0x40] }).problem).toMatch(/4 free tile types needed/);
});

test("a type a record holds (an oracle's object, a teleporter's cell) is not free", () => {
  const room = game.episode(0).rooms[0];
  // Junior would take 0x50 and 0x51 for the oracles; a type 12 record names 0x50 at
  // offset 8 (what the oracle turns into), a type 13 one 0x51 at offset 2
  const oracle = Uint8Array.of(12, 0, 0, 0, 0, 0, 0, 0, 0x50, 0);
  const teleporter = Uint8Array.of(13, 0, 0x51, 0, 0, 0, 0, 0, 0, 0);
  const records = [...room.records, { slot: 200, data: oracle }, { slot: 201, data: teleporter }];
  const rooms = game.episode(0).rooms.map((r) => (r === room ? { ...r, records } : r));
  const changed = new Game(game.withScene(0, rooms));
  const types = planKit(changed, 0, oracles, { source: game }).types;
  expect(types.map(([, of]) => of)).toEqual([0x50, 0x51]);
  expect(types.map(([to]) => to).filter((to) => to === 0x50 || to === 0x51)).toEqual([]);
});
