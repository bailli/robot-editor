import assert from "node:assert/strict";

import { expect, test } from "vitest";

import { EPISODES, Game } from "../src/game.ts";
import { displayText, parseObjectNames, parseTexts, textPieces } from "../src/texts.ts";
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
