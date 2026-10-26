import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, test } from "vitest";

import { readEpisodeStart, withExitMode } from "@robot/formats";

import { Driver, type HeroState, type Key } from "../src/driver.ts";
import { ROOT, loadGame } from "../src/game.ts";
import { calmRoom } from "../src/patch.ts";

/**
 * Runs the real game under Wine through the proxy DLL (see driver.ts). Opt-in, as it
 * starts Wine for every test: `pnpm proxy` once, then `pnpm test:game`.
 */
const enabled = process.env["ROBOT_GAME_TESTS"] === "1";
const built = existsSync(new URL("tools/wine/proxy/ddraw.dll", ROOT));
const HINT = "`pnpm proxy`, then `pnpm test:game` (needs Wine, Xvfb, harness.py setup)";

async function withGame<T>(exe: string | undefined, use: (d: Driver) => Promise<T>): Promise<T> {
  const d = await Driver.start(exe ? { exe } : {});
  try {
    return await use(d);
  } finally {
    d.close();
  }
}

/** Holds `key` until `done` holds for the hero, then lets go. */
async function walk(d: Driver, key: Key, done: (hero: HeroState) => boolean): Promise<HeroState> {
  await d.key(key, true);
  await d.until(async () => {
    const hero = await d.hero();
    return hero !== undefined && done(hero);
  }, 3000);
  await d.key(key, false);
  await d.run(20);
  const hero = await d.hero();
  assert.ok(hero);
  return hero;
}

describe.skipIf(!enabled || !built)(`the game through the proxy (${HINT})`, () => {
  const game = loadGame();

  for (const episode of [0, 1, 2, 3, 4]) {
    test(`episode ${String(episode)} starts in the room and cell of its start method`, async () => {
      const hero = await withGame(undefined, (d) => d.startEpisode(episode));
      assert.deepEqual(hero, readEpisodeStart(game.image, episode));
    }, 60_000);
  }

  test("runs repeat exactly: the same steps reach the same game tick", async () => {
    const ticks = [];
    for (let run = 0; run < 2; run++) {
      ticks.push(
        await withGame(undefined, async (d) => {
          await d.startEpisode(1);
          await d.hold("right", 100);
          return { status: await d.status(), hero: await d.hero() };
        }),
      );
    }
    assert.deepEqual(ticks[1], ticks[0]);
  }, 60_000);

  test("episode I: without robots and with a west neighbour, room 43 leads to 42", async () => {
    const dir = mkdtempSync(join(tmpdir(), "robot-driver-"));
    try {
      const exe = join(dir, "GameOfRobot.exe");
      const ep = game.episode(1);
      const rooms = ep.rooms.map((r) =>
        r.id === 43 ? withExitMode(calmRoom(r, ep.classes), "west", "neighbour") : r,
      );
      writeFileSync(exe, game.withScene(1, rooms));
      const arrived = await withGame(exe, async (d) => {
        await d.startEpisode(1);
        // around the inner wall west of the start: east, north, west, south to the exit
        await walk(d, "right", (h) => h.x >= 8);
        await walk(d, "up", (h) => h.y <= 8);
        await walk(d, "left", (h) => h.x <= 2);
        await walk(d, "down", (h) => h.y >= 15);
        return walk(d, "left", (h) => h.room !== 43);
      });
      assert.deepEqual(arrived, { room: 42, x: 38, y: 15 });
    } finally {
      rmSync(dir, { recursive: true });
    }
  }, 60_000);
});
