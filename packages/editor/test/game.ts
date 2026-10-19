import { commands } from "vitest/browser";

import { Game } from "@robot/formats";

let bytes: Promise<Uint8Array> | undefined;

/** reference/GameOfRobot.exe (see README), read through the test server (relative to packages/editor). */
export function exeBytes(): Promise<Uint8Array> {
  bytes ??= commands
    .readFile("../../reference/GameOfRobot.exe", "base64")
    .then((base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)));
  return bytes;
}

export async function loadGame(): Promise<Game> {
  return new Game(await exeBytes());
}

/** Index of the first differing element, -1 if equal (toEqual is slow on large arrays). */
export function firstDifference(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/** The value, or a test failure if it is undefined. */
export function defined<T>(value: T | undefined, what = "value"): T {
  if (value === undefined) throw new Error(`${what} is undefined`);
  return value;
}
