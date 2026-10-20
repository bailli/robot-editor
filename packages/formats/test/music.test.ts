import { expect, test } from "vitest";

import { EPISODES, Game } from "../src/game.ts";
import { MusicFormatError, musicPieces } from "../src/music.ts";
import { roomSettings } from "../src/room-tags.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

test("every episode's MUSIC resource lists its pieces, sorted by name", () => {
  const counts = EPISODES.map((e) => game.musicPieces(e).length);
  expect(counts).toEqual([26, 48, 72, 55, 64]);
  for (const episode of EPISODES) {
    const pieces = game.musicPieces(episode);
    expect(pieces).toEqual([...pieces].sort((a, b) => (a < b ? -1 : 1)));
  }
  expect(game.musicPieces(2)).toContain("WÜSTE");
  expect(game.musicPieces(3)).toContain("BRANDUNG");
});

test("the rooms' music is a piece of their episode, but for episode III's HUMBA", () => {
  for (const episode of EPISODES) {
    const pieces = new Set(game.musicPieces(episode));
    const missing = game
      .episode(episode)
      .rooms.map((r) => roomSettings(r).music)
      .filter((m) => m !== "" && !pieces.has(m));
    expect(missing).toEqual(episode === 3 ? ["HUMBA"] : []);
  }
});

test("data without the signature is refused", () => {
  expect(() => musicPieces(new Uint8Array(0x40))).toThrow(MusicFormatError);
  expect(() => musicPieces(new Uint8Array(4))).toThrow(MusicFormatError);
});
