import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { SCREEN_WIDTH, TILE_HEIGHT, TILE_WIDTH, renderRoom } from "../src/render.ts";
import { cryptScene } from "../src/scene-crypt.ts";
import { ROOM_HEIGHT, ROOM_WIDTH, parseScene } from "../src/scene.ts";
import { parseShapes } from "../src/shapes.ts";
import { ROOT, resource, sha256 } from "./data.ts";

/**
 * Compares our renders with screenshots taken in the real game (tools/wine/take_shots.py).
 * shots.json is committed and lists, per screenshot, the cells where the render differs
 * today (actors, animations and not yet understood tile classes). The test requires
 * exactly that set: a regression fails, and so does an improvement, which is then
 * recorded by re-running take_shots.py and shows up in review as a diff of shots.json.
 */
interface Shot {
  episode: number;
  room: number;
  file: string;
  sha256: string;
  differingCells: [number, number][];
}

const shots = JSON.parse(readFileSync(new URL("shots.json", ROOT), "utf8")) as Shot[];
const HINT = "run `python3 tools/wine/take_shots.py` (needs Wine)";

function differingCells(game: Uint8Array, ours: Uint8Array): [number, number][] {
  const cells: [number, number][] = [];
  for (let cy = 1; cy < ROOM_HEIGHT; cy++) {
    for (let cx = 0; cx < ROOM_WIDTH; cx++) {
      let differs = false;
      for (let y = 0; y < TILE_HEIGHT && !differs; y++) {
        const row = (cy * TILE_HEIGHT + y) * SCREEN_WIDTH + cx * TILE_WIDTH;
        for (let x = 0; x < TILE_WIDTH; x++) {
          if (game[row + x] !== ours[row + x]) {
            differs = true;
            break;
          }
        }
      }
      if (differs) cells.push([cx, cy]);
    }
  }
  return cells;
}

for (const shot of shots) {
  const path = new URL(shot.file, ROOT);
  const name = `episode ${shot.episode} room ${shot.room} matches the game screenshot except the known cells`;
  test(name, { skip: existsSync(path) ? false : `${shot.file} is missing: ${HINT}` }, () => {
    const game = new Uint8Array(readFileSync(path));
    assert.equal(
      sha256(game),
      shot.sha256,
      `${shot.file} differs from the one in shots.json: ${HINT}`,
    );
    const objects = parseShapes(resource("SHAPES", `1${shot.episode}02`)).get("_Rob_object");
    assert.ok(objects);
    const room = parseScene(cryptScene(resource("SCENE", `1${shot.episode}04`))).find(
      (r) => r.id === shot.room,
    );
    assert.ok(room);
    const actual = differingCells(game, renderRoom(room, objects));
    const key = ([x, y]: [number, number]) => `${x},${y}`;
    const known = new Set(shot.differingCells.map(key));
    const now = new Set(actual.map(key));
    const regressed = actual.filter((c) => !known.has(key(c)));
    const improved = shot.differingCells.filter((c) => !now.has(key(c)));
    assert.deepEqual(
      { newlyDiffering: regressed, nowMatching: improved },
      { newlyDiffering: [], nowMatching: [] },
      `cells (x,y) changed against the game screenshot; if intended: ${HINT}`,
    );
  });
}
