import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";

import { describe, test } from "vitest";

import { Driver } from "../src/driver.ts";
import { ROOT } from "../src/game.ts";

/**
 * The native wrapper against Wine: the same input on both gives the same game, frame for
 * frame. Opt-in, as it needs both (`pnpm wrapper`, `pnpm proxy`, Wine with
 * `harness.py setup`): `pnpm test:game:cross`.
 */
const enabled = process.env["ROBOT_CROSS_TESTS"] === "1";
const built =
  existsSync(new URL("tools/linux/robot", ROOT)) &&
  existsSync(new URL("tools/wine/proxy/ddraw.dll", ROOT)) &&
  existsSync(new URL(".wine/prefix/", ROOT));
const HINT = "`pnpm wrapper`, `pnpm proxy`, then `pnpm test:game:cross` (needs Wine, Xvfb)";

/** What a run shows at its end, compared between the two. */
interface Seen {
  hero: unknown;
  tick: number;
  frame: string;
  palette: string;
  frames: string[];
}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Starts the episode, walks, and records the frames on the way. */
async function play(native: boolean, episode: number): Promise<Seen> {
  const d = await Driver.start({ native });
  try {
    await d.startEpisode(episode);
    const frames: string[] = [];
    for (const key of ["right", "down", "left", "up"] as const) {
      await d.hold(key, 25);
      await d.run(10);
      frames.push(hash((await d.frame()).indices));
    }
    const frame = await d.frame();
    // only the colours the frame uses: the game's table maps its unused last slots through
    // leftover words of its own memory, which differ between the two
    const used = [...new Set(frame.indices)].sort((a, b) => a - b);
    const colours = await d.palette();
    const palette = used.map((i) => `${String(i)}:${(colours[i] ?? []).join(",")}`);
    return {
      hero: await d.hero(),
      tick: (await d.status()).tick,
      frame: hash(frame.indices),
      palette: palette.join(" "),
      frames,
    };
  } finally {
    await d.close();
  }
}

// asked for but not built: a failure, not a run that passes without playing
test.runIf(enabled && !built)("the game tests need the build", () => {
  assert.fail(`not built: ${HINT}`);
});

describe.skipIf(!enabled || !built)(`the native wrapper against Wine (${HINT})`, () => {
  for (const episode of [0, 1, 2, 3, 4]) {
    test(`episode ${String(episode)}: the same frames, tick and hero`, async () => {
      const wine = await play(false, episode);
      const native = await play(true, episode);
      assert.deepEqual(native, wine);
    }, 120_000);
  }
});
