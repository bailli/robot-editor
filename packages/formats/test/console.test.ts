import { expect, test } from "vitest";

import {
  decodeConsoleString,
  readConsole,
  readConsoleObjects,
  withConsole,
} from "../src/console.ts";
import { Game } from "../src/game.ts";
import { parsePe, readVa } from "../src/pe.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("the console is off in the original and on after the patch, two bytes changed", () => {
  expect(readConsole(game.image)).toBe(false);
  const patched = parsePe(withConsole(game.image));
  expect(readConsole(patched)).toBe(true);
  const changed = patched.data.reduce((n, b, i) => n + Number(b !== game.image.data[i]), 0);
  expect(changed).toBe(2);
  expect(readConsole(parsePe(withConsole(patched)))).toBe(true);
});

test("the console's words decode; others are no obfuscated strings", () => {
  const at = (va: number) => {
    const bytes = readVa(game.image, va, 32);
    return decodeConsoleString(bytes.subarray(0, bytes.indexOf(0)));
  };
  expect([0x4828ac, 0x4828d4, 0x482930].map(at)).toEqual(["Robot32Command", "SEND", "SCENE"]);
  expect(at(0x4828c0)).toBeUndefined(); // "Command %s unknown!" in plain text
});

test("the objects' names and how a state is given", () => {
  const objects = readConsoleObjects(game.image);
  expect(objects).toHaveLength(111);
  const usage = new Map(objects.map((o) => [o.name, o.usage]));
  expect(usage.get("GOLD")).toBe("GOLD");
  expect(usage.get("KEY")).toBe("KEY(0-15)");
  expect(usage.get("LETTER")).toBe("LETTER(A-Z)");
  expect(usage.get("NOTE")).toBe("NOTE(0-255)");
  expect(usage.get("LCARD")).toBe("LCARD(word)");
  expect(usage.get("MONEY")).toBe("MONEY"); // its one state is given for it
  expect(usage.has("SCENE")).toBe(false); // a command, not an object
});
