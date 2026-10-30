import { expect, test } from "vitest";

import { readConsole, withConsole } from "../src/console.ts";
import { Game } from "../src/game.ts";
import { parsePe } from "../src/pe.ts";
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
