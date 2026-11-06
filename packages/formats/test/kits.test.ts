import { expect, test } from "vitest";

import { readEpisodeFlags } from "../src/episode-flags.ts";
import { Game } from "../src/game.ts";
import { KITS, kitChanges, kitExample, planKit } from "../src/kits.ts";
import { NO_CHANGES, applyMod, emptyMod } from "../src/mod.ts";
import { exe } from "./data.ts";

const game = new Game(exe());
const kit = (key: string) => {
  const found = KITS.find((k) => k.key === key);
  if (!found) throw new Error(key);
  return found;
};
const [oracles, circuits, goal] = [kit("oracles"), kit("circuits"), kit("goal")];

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
    code: [],
    textCopies: [],
    moved: [],
    silenced: [],
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
    code: [],
    texts: [],
    flags: [],
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

test("goal: Junior's, its text moved to 1700 (a code patch); event 298 without a bonus box", () => {
  const jump = {
    va: 0x41f45f,
    expect: Uint8Array.of(0xe2, 3, 0, 0),
    bytes: Uint8Array.of(0xa4, 6, 0, 0),
  };
  // Junior has it; III lacks event 298 (raised, it gives entry 0: nothing) and keeps its
  // own 994 (the wood message)
  expect(planKit(game, 0, goal)).toMatchObject({ types: [], present: [0x32], code: [] });
  expect(planKit(game, 3, goal)).toMatchObject({
    texts: [],
    code: [jump],
    textCopies: [
      { resource: 1010, from: 1010, entries: [[1700, 994]] },
      { resource: 1310, from: 1010, entries: [[1700, 994]] },
      { resource: 1011, from: 1011, entries: [[1700, 994]] },
    ],
    events: [],
    moved: [],
    silenced: [],
  });
  // I: English too; 298 in entry 170 with text 1970 ("Das war's"), moved to entry 190
  const i = planKit(game, 1, goal);
  expect(i).toMatchObject({ texts: [], silenced: [] });
  expect(i.types.map(([, of]) => of)).toEqual([0x32]);
  expect(i.moved).toEqual([
    // FINALE: the music of I's ending (0x4095e0 plays event 298's sound), which follows
    { entry: 190, from: 170, id: 298, points: 10000, sound: "FINALE", freed: { id: 0, points: 0 } },
  ]);
  const changes = kitChanges(game, 1, goal, i);
  expect(changes.events).toEqual([
    { episode: 1, entry: 190, id: 298, points: 10000, sound: "FINALE" },
    { episode: 1, entry: 170, id: 0, points: 0 },
  ]);
  expect(changes.code).toEqual([jump]);
  expect(changes.copyTexts).toEqual([
    { resource: 1010, from: 1010, entries: [[1700, 994]] },
    { resource: 1110, from: 1010, entries: [[1700, 994]] },
    { resource: 1011, from: 1011, entries: [[1700, 994]] },
    { resource: 1111, from: 1011, entries: [[1700, 994]] },
  ]);
  // II has no spare entry: its text 1970 would go (II has no free type either)
  const ii = planKit(game, 2, goal);
  expect(ii).toMatchObject({ moved: [], silenced: [170], problem: /free tile types/ });
  expect(kitChanges(game, 2, goal, ii).texts).toEqual([
    { resource: 1210, entry: 1970, variants: null },
  ]);
  // IV: 1970 is the helicopter's text too, so 298 moves to 197 (id 388 goes to 170)
  expect(planKit(game, 4, goal).moved).toMatchObject([
    { entry: 197, from: 170, id: 298, freed: { id: 388, points: 0 } },
  ]);
  // once added, the episodes keep their own 994; then nothing is left to do, and IV
  // takes only its copy and the event
  const added = new Game(
    applyMod(game.image, { ...emptyMod(game.image.data), changes: { ...NO_CHANGES, ...changes } }),
  );
  for (const e of [0, 1]) {
    const texts = added.texts(1010 + 100 * e)?.entries;
    expect(texts?.get(994)).toEqual(game.texts(1010 + 100 * e)?.entries.get(994));
    expect(texts?.get(1700)).toEqual(game.texts(1010)?.entries.get(994));
  }
  expect(planKit(added, 1, goal, { source: game })).toMatchObject({
    types: [],
    code: [],
    textCopies: [],
    moved: [],
  });
  expect(planKit(added, 4, goal, { source: game })).toMatchObject({
    code: [],
    textCopies: [{ resource: 1410, from: 1010, entries: [[1700, 994]] }],
  });
});

test("woods & boots: III's woods and boots, only where the episode has no woods", () => {
  const woods = kit("woods");
  expect(planKit(game, 0, woods).types).toEqual([
    [0x4c, 0x4c],
    [0x4b, 0x4b],
  ]);
  for (const e of [2, 3, 4]) expect(planKit(game, e, woods).present).toEqual([0x4c, 0x4b]);
});

test("axe & bridges: tools, timber, bridge; the timber's text moved; flag 0x20000", () => {
  const axe = kit("axe");
  const move = {
    va: 0x415b20,
    expect: Uint8Array.of(0xe2, 3, 0, 0),
    bytes: Uint8Array.of(0xa5, 6, 0, 0),
  };
  // IV has woods and a river, two of its four spare entries take the events
  const iv = planKit(game, 4, axe);
  expect(iv).toMatchObject({
    types: [
      [0x48, 0x61],
      [0x6d, 0x62],
      [0x6f, 0x2b],
      [0x6e, 0x6e],
    ],
    present: [0x4c, 0x12],
    texts: [285],
    events: [
      { entry: 197, id: 335 },
      { entry: 198, id: 331 },
    ],
    code: [move],
    textCopies: [
      { resource: 1310, from: 1310, entries: [[1701, 994]] },
      { resource: 1410, from: 1310, entries: [[1701, 994]] },
    ],
    flags: 0x22312ccd | 0x20000,
  });
  // II has no free type (its types without rooms are the game's own pictures)
  expect(planKit(game, 2, axe).problem).toMatch(/4 free tile types needed, 0 left/);
  // Junior gets III's woods and river too
  expect(planKit(game, 0, axe).types.map(([, of]) => of)).toEqual([
    0x61, 0x62, 0x2b, 0x6e, 0x4c, 0x12,
  ]);
  // III has it all, flag included
  expect(planKit(game, 3, axe)).toMatchObject({ types: [], code: [], textCopies: [] });
  expect(planKit(game, 3, axe).flags).toBeUndefined();
  // applied: the flag is set, the timber shows 1701, which holds III's 994 there
  const changes = kitChanges(game, 4, axe, iv);
  expect(changes.flags).toEqual([{ episode: 4, flags: 0x22332ccd }]);
  const added = new Game(
    applyMod(game.image, { ...emptyMod(game.image.data), changes: { ...NO_CHANGES, ...changes } }),
  );
  expect(readEpisodeFlags(added.image, 4)).toBe(0x22332ccd);
  expect(added.texts(1410)?.entries.get(1701)).toEqual(game.texts(1310)?.entries.get(994));
  expect(added.texts(1310)?.entries.get(1701)).toEqual(game.texts(1310)?.entries.get(994));
  expect(added.texts(1410)?.entries.get(285)).toEqual(game.texts(1310)?.entries.get(285));
  // once added, nothing is left to do
  expect(planKit(added, 4, axe, { source: game })).toMatchObject({
    types: [],
    texts: [],
    code: [],
    textCopies: [],
  });
  expect(planKit(added, 4, axe, { source: game }).flags).toBeUndefined();
});

test("fire & bucket, swimming: a river and water where the episode has none, their texts", () => {
  const [fire, swimming] = [kit("fire"), kit("swimming")];
  // Junior: no river (its 0x12 is another class) and no water
  expect(planKit(game, 0, fire)).toMatchObject({
    types: [
      [0x67, 0x67],
      [0x66, 0x66],
      [0x4f, 0x4f],
      [0x3a, 0x12],
      [0x3b, 0x25],
    ],
    texts: [947],
    events: [],
    lacking: [],
  });
  expect(planKit(game, 1, fire)).toMatchObject({ present: [0x12, 0x25], texts: [947] });
  expect(planKit(game, 0, swimming)).toMatchObject({
    types: [
      [0x60, 0x60],
      [0x3a, 0x12],
      [0x3b, 0x25],
    ],
    texts: [230],
  });
  // IV has flippers, river and water but not text 230
  expect(planKit(game, 4, swimming)).toMatchObject({ types: [], texts: [230] });
  expect(planKit(game, 2, swimming)).toMatchObject({ types: [], texts: [] });
});

test("the new kits' examples in Junior, with the kits' types", () => {
  for (const key of ["woods", "axe", "fire", "swimming"]) {
    const chosen = kit(key);
    const changes = kitChanges(game, 0, chosen, planKit(game, 0, chosen));
    const added = new Game(
      applyMod(game.image, {
        ...emptyMod(game.image.data),
        changes: { ...NO_CHANGES, ...changes },
      }),
    );
    expect(kitExample(game, 0, chosen, 43), key).toBeUndefined();
    const example = kitExample(added, 0, chosen, 43);
    expect(example, key).toBeDefined();
    if (!example) continue;
    expect(example.base.length).toBe(example.w * example.h);
    // every cell is one of the kit's types (or floor)
    const types = new Set(changes.tileTypes.flatMap((c) => c.types.map(([to]) => to)));
    for (const c of [...example.base, ...example.overlay])
      expect(c === 0 || types.has(c & 0xff), `${key}: 0x${c.toString(16)}`).toBe(true);
  }
});
