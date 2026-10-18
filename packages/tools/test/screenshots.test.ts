import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { renderRoom } from "@robot/formats";

import { Game, ROOT } from "../src/game.ts";
import { differingCells, readManifest, readShot, sha256 } from "../src/shots.ts";

/**
 * Compares our renders with screenshots taken in the real game (`robot shots`).
 * shots.json lists the cells where the render differs today (actors, animations, not
 * yet understood classes); the test requires exactly that set, so regressions fail and
 * improvements are recorded deliberately (`robot shots --update`, reviewed as a diff).
 */
const HINT = "run `pnpm robot shots` (needs Wine) or `pnpm robot shots --update`";
const game = Game.load();

for (const shot of readManifest()) {
  const present = existsSync(new URL(shot.file, ROOT));
  const name = `episode ${shot.episode} room ${shot.room}${shot.patched ? " (patched start)" : ""} matches the game screenshot except the known cells`;
  test(name, { skip: present ? false : `${shot.file} is missing: ${HINT}` }, () => {
    const indices = readShot(shot.file);
    assert.equal(
      sha256(indices),
      shot.sha256,
      `${shot.file} differs from the one in shots.json: ${HINT}`,
    );
    const ep = game.episode(shot.episode);
    const actual = differingCells(
      indices,
      renderRoom(game.room(shot.episode, shot.room), ep.objects, ep.classes),
    );
    const key = ([x, y]: [number, number]) => `${x},${y}`;
    const known = new Set(shot.differingCells.map(key));
    const now = new Set(actual.map(key));
    assert.deepEqual(
      {
        newlyDiffering: actual.filter((c) => !known.has(key(c))),
        nowMatching: shot.differingCells.filter((c) => !now.has(key(c))),
      },
      { newlyDiffering: [], nowMatching: [] },
      `cells (x,y) changed against the game screenshot; if intended: ${HINT}`,
    );
  });
}
