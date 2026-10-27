import assert from "node:assert/strict";

import { expect, test } from "vitest";

import { EPISODES, Game, textsId } from "../src/game.ts";
import {
  displayText,
  parseObjectNames,
  parseTexts,
  textEntryProblem,
  textPieces,
  withTextEntry,
} from "../src/texts.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("entries have as many variants as their header says", () => {
  for (const episode of EPISODES) {
    for (const language of ["de", "en"] as const) {
      const texts = game.episodeTexts(episode, language);
      if (!texts) continue;
      for (const [n, variants] of texts.entries) {
        assert.ok(variants.length > 0, `${episode} ${language} ${n}`);
      }
    }
  }
  const parsed = parseTexts("1.0\n0:2\nfirst|\nsecond;\n\n5:\n6:\nshared;\n\n7:\n;\n");
  expect(parsed.version).toBe("1.0");
  expect([...parsed.entries]).toEqual([
    [0, ["first", "second"]],
    [5, ["shared"]],
    [6, ["shared"]],
    [7, [""]],
  ]);
});

test("English texts exist for Junior and episode I only", () => {
  expect(EPISODES.map((e) => game.episodeTexts(e, "en") !== undefined)).toEqual([
    true,
    true,
    false,
    false,
    false,
  ]);
  expect(game.episodeTexts(0, "en")?.entries.get(0)?.[0]).toMatch(/^There/);
});

test("tile descriptions say what doors and stairs are", () => {
  const texts = game.episodeTexts(3);
  // variants by state where it matters: stairs down (state 0) and up (state 1)
  expect(texts?.entries.get(0x3d)).toEqual([
    "Diese Treppen führen hinunter.",
    "Diese Treppen führen hinauf.",
  ]);
  expect(texts?.entries.get(0x5a)).toEqual(["Der Ausgang des Hauses!"]);
  expect(texts?.entries.get(0x53)?.slice(0, 2)).toEqual([
    "Dies ist schlicht ein Teil des Daches!",
    "Richtig, das sind Eingänge zum Haus.",
  ]);
});

test("displayText undoes the game's line wrapping and colours", () => {
  expect(displayText("Du darfst diesen Ge-\\\ngenstand ²Jnicht²0 besit-\\\nzen,\\\nwenn")).toBe(
    "Du darfst diesen Gegenstand nicht besitzen, wenn",
  );
  expect(displayText("Mit einer Leiter kann man\nalles überwinden.")).toBe(
    "Mit einer Leiter kann man alles überwinden.",
  );
  expect(displayText("Liebling,\\bring │\n└──┘\\")).toBe("Liebling, bring │ └──┘");
});

test("the sound tables name the episodes' objects", () => {
  expect([...parseObjectNames("8:KLINGELI ;O_LADDER\n10:!GOLD ;O_GOLD\n128:X ;O_NO\n")]).toEqual([
    [8, "LADDER"],
    [10, "GOLD"],
  ]);
  expect(
    EPISODES.map((e) => [...game.objectNames(e)].map(([t, n]) => `${t} ${n}`).join(", ")),
  ).toMatchSnapshot();
});

test("tile codes split texts into text and the tiles drawn in it", () => {
  expect(textPieces("bei der Bank @14 gegen @a@a, @@ und @0139*0@0139*1")).toEqual([
    { kind: "text", text: "bei der Bank " },
    { kind: "tile", value: 0x14 },
    { kind: "text", text: " gegen " },
    { kind: "tile", value: 0x0a },
    { kind: "tile", value: 0x0a },
    { kind: "text", text: ", @ und " },
    { kind: "tile", value: 0x0139, slice: 0 },
  ]);
  // hard spaces, and names for the tiles
  expect(displayText("Diese @7@7_Zäune", (v) => `t${v}`)).toBe("Diese [t7][t7] Zäune");
});

test("entries can be set, added and removed; shared texts stay with the others", () => {
  const text = "1.0\n1:\none;\n\n2:\n3:2\nshared|\nby two;\n\n4:\nfour;\n";
  const before = parseTexts(text).entries;
  const check = (id: number, variants: string[] | undefined) => {
    const after = parseTexts(withTextEntry(text, id, variants)).entries;
    const expected = new Map(before);
    if (variants) expected.set(id, variants);
    else expected.delete(id);
    expect(after, `${id} ${String(variants)}`).toEqual(expected);
  };
  for (const id of [1, 2, 3, 4, 5]) {
    check(id, ["new"]);
    check(id, ["a", "b"]);
    if (id !== 5) check(id, undefined);
  }
  expect(withTextEntry(text, 4, ["vier"])).toBe(
    "1.0\n1:\none;\n\n2:\n3:2\nshared|\nby two;\n\n4:\nvier;\n",
  );
  expect(withTextEntry(text, 7, ["sieben"])).toBe(`${text}\n7:\nsieben;\n`);
  // a header without text at the end does not take the new entry's
  const open = `${text}\n9:\n`;
  expect(parseTexts(withTextEntry(open, 10, ["zehn"])).entries).toEqual(
    new Map([...parseTexts(open).entries, [10, ["zehn"]]]),
  );
  expect(textEntryProblem("a;b")).toBeDefined();
  expect(textEntryProblem("ok\n12: no")).toBeDefined();
  expect(textEntryProblem("Raum 12 ist hier")).toBeUndefined();
  expect(textEntryProblem("DEL \x7f")).toBeDefined(); // crunch cannot store it
  expect(() => withTextEntry(text, 1, ["a|b"])).toThrow(RangeError);
});

test("every original entry can be rewritten without changing the others", () => {
  const source = game.textSource(textsId(1));
  assert.ok(source);
  const before = parseTexts(source).entries;
  for (const id of [0, 0x3d, 1043, 999]) {
    const after = parseTexts(withTextEntry(source, id, ["neu"])).entries;
    for (const [n, variants] of before)
      if (n !== id) expect(after.get(n), `${id}: ${n}`).toEqual(variants);
    expect(after.get(id)).toEqual(["neu"]);
  }
});
