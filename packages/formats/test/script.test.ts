import { expect, test } from "vitest";

import { roomScript } from "../src/exits.ts";
import { EPISODES, Game } from "../src/game.ts";
import {
  Op,
  compileScript,
  disassemble,
  parseCompiledScript,
  roomCompiledScript,
  withRoomScript,
} from "../src/script.ts";
import { assertBytesEqual, exe } from "./data.ts";

const game = new Game(exe());
const keywords = game.scriptKeywords();

const scripted = EPISODES.flatMap((episode) =>
  game.episode(episode).rooms.flatMap((room) => {
    const compiled = roomCompiledScript(room);
    return compiled ? [{ episode, room, compiled }] : [];
  }),
);

test("128 rooms have compiled scripts, all of them readable", () => {
  expect(scripted.length).toBe(128);
  for (const { episode, room, compiled } of scripted) {
    const script = parseCompiledScript(compiled);
    expect(script.code.at(0)?.op, `${episode} ${room.id}`).toBe(Op.SYMBOLS);
    expect(script.code.at(-1)?.op, `${episode} ${room.id}`).toBe(Op.END);
  }
});

test("the compiler reproduces every compiled script from its source", () => {
  for (const { episode, room, compiled } of scripted) {
    const constants = game.scriptConstants(episode);
    const ours = compileScript(roomScript(room), { constants, keywords });
    assertBytesEqual(ours, compiled, `episode ${episode} room ${room.id}`);
  }
});

test("a small script compiled and disassembled", () => {
  const constants = game.scriptConstants(1);
  const bytes = compileScript("if (NewRoom) Message(700, 25);\nRandObj(O_ALIEN, n = 5, -1);", {
    constants,
    keywords,
  });
  expect(disassemble(parseCompiledScript(bytes))).toMatchInlineSnapshot(`
    "   0  symbols NewRoom/1/0 Message/3/2 RandObj/3/3 n/1/0
      58  load NewRoom
      59  jump if false 72
      61  push 700
      64  arg
      65  push 25
      67  arg
      68  call Message
      70  drop 2
      72  push 2
      74  arg
      75  push 5
      77  store n
      79  arg
      80  push 1
      82  neg
      83  arg
      84  call RandObj
      86  drop 3
      88  end"
  `);
});

test("the game's keywords and the script constants", () => {
  expect(keywords.length).toBe(62);
  expect(keywords.find((k) => k.name === "RandObj")).toEqual({
    name: "RandObj",
    flags: 0x40,
    address: 0x4073a0,
    args: 3,
  });
  expect(keywords.find((k) => k.name === "Score")).toMatchObject({
    flags: 0x83,
    address: 0x4fe2f0,
  });
  // Area is there twice, with 3 and 4 arguments
  expect(keywords.filter((k) => k.name === "Area").map((k) => k.args)).toEqual([3, 4]);
  // the same class, a different tile type
  expect(EPISODES.map((e) => game.scriptConstants(e).get("O_SAND"))).toEqual([39, 49, 49, 49, 49]);
  expect(game.scriptConstants(1).get("O_KEY")).toBe(21);
});

test("the compiler rejects what the game would not run", () => {
  const constants = game.scriptConstants(1);
  const compile = (source: string) => () => compileScript(source, { constants, keywords });
  expect(compile("Mesage(1, 0);")).toThrow("unknown function Mesage");
  expect(compile("Message(1);")).toThrow("Message takes 2 arguments, not 1");
  expect(compile("Area(1, 2);")).toThrow("Area takes 3 or 4 arguments, not 2");
  expect(compile("Foo = 1;")).toThrow("unknown variable Foo");
  expect(compile("RandObj(O_NOTHING, 1, 2);")).toThrow("unknown constant O_NOTHING");
  expect(compile("if (Score > 1 Message(1, 0);")).toThrow('expected ")" at line 1, column 15');
  expect(compile("Message(1, 0); Message(1);")).toThrow("Message called with 1 and 2 arguments");
  // local variables start in lower case
  expect(compile("count = Score;")).not.toThrow();
});

test("withRoomScript writes source and compiled script where the game's scenes have them", () => {
  let same = 0;
  for (const { episode, room } of scripted) {
    const options = { constants: game.scriptConstants(episode), keywords };
    const copy = withRoomScript(room, roomScript(room), options);
    // the originals end with a zero; 13 in episode II have two leftover bytes after it
    if (JSON.stringify(copy.tags) === JSON.stringify(room.tags)) same++;
  }
  expect(same).toBe(115);
  const room = game.room(1, 43);
  expect(withRoomScript(room, "").tags.map((t) => `${t.kind}/${t.value}`)).toEqual(["1/32", "6/3"]);
  const added = withRoomScript(withRoomScript(room, ""), "Score = 1;", { keywords });
  expect(added.tags.map((t) => `${t.kind}/${t.value}`)).toEqual(["1/32", "6/1", "6/2", "6/3"]);
  expect(roomScript(added)).toBe("Score = 1;");
});
