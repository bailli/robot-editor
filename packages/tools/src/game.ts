import { readFileSync } from "node:fs";

import { Game } from "@robot/formats";

/** Repository root (game data and generated files are relative to it). */
export const ROOT = new URL("../../../", import.meta.url);
export const DEFAULT_EXE = new URL("reference/GameOfRobot.exe", ROOT);

export function loadGame(path: URL | string = DEFAULT_EXE): Game {
  return new Game(new Uint8Array(readFileSync(path)));
}
