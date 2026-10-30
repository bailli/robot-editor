import { expect, test } from "vitest";

import { EPISODES, Game, musicId } from "../src/game.ts";
import {
  MAX_MUSIC_PIECES,
  MusicFormatError,
  musicPieces,
  readMusic,
  withMusicPieces,
} from "../src/music.ts";
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

const music = (episode: number) => game.resource("MUSIC", musicId(episode)).data;

/** A piece's entry without what a copy changes: the data's offset, the instruments. */
const entryRest = (entry: Uint8Array) =>
  Array.from(entry).filter((_, i) => (i < 8 || i >= 12) && !(i >= 0x14 && i < 0x54 && i % 4 === 2));

test("withMusicPieces adds pieces with their instruments at the end; the rest stays", () => {
  const lacked = game.musicPieces(2).filter((p) => !game.musicPieces(4).includes(p));
  expect(lacked.length).toBeGreaterThan(20);
  const out = withMusicPieces(music(4), music(2), lacked);
  const [before, after, from] = [readMusic(music(4)), readMusic(out), readMusic(music(2))];
  expect(after.pieces.map((p) => p.name)).toEqual([...game.musicPieces(4), ...lacked]);
  // its own pieces play as before: their data, entries and instruments
  expect(after.instruments.slice(0, before.instruments.length)).toEqual(before.instruments);
  before.pieces.forEach((p, n) => {
    expect(after.pieces[n].data).toEqual(p.data);
    expect(entryRest(after.pieces[n].entry)).toEqual(entryRest(p.entry));
    expect(after.pieces[n].entry.subarray(0x14, 0x54)).toEqual(p.entry.subarray(0x14, 0x54));
  });
  // a copy plays the same notes on the same instruments, each added once
  let shared = 0;
  for (const name of lacked) {
    const [a, s] = [after, from].map((m) => m.pieces.find((p) => p.name === name));
    expect(a?.data).toEqual(s?.data);
    expect(entryRest(a?.entry ?? new Uint8Array())).toEqual(
      entryRest(s?.entry ?? new Uint8Array()),
    );
    for (let slot = 0; slot < 16; slot++) {
      const at = 0x14 + slot * 4;
      if (((s?.entry[at] ?? 0) & 1) === 0) continue;
      const index = a?.entry[at + 2] ?? 0;
      expect(after.instruments[index]).toEqual(from.instruments[s?.entry[at + 2] ?? 0]);
      if (index < before.instruments.length) shared++;
    }
  }
  expect(shared).toBeGreaterThan(0);
  const added = after.instruments.slice(before.instruments.length).map((i) => i.join());
  expect(new Set(added).size).toBe(added.length);
  expect(() => withMusicPieces(out, music(2), [lacked[0]])).toThrow(/already/);
});

test("episode I's bytes after its data stay; its speaker parts past the instruments too", () => {
  const out = withMusicPieces(music(1), music(2), ["ORACLE"]);
  const before = readMusic(music(1));
  const after = readMusic(out);
  expect(after.pieces.slice(0, -1).map((p) => p.data)).toEqual(before.pieces.map((p) => p.data));
  // the 5 bytes after the data come before the copy's
  const copy = after.pieces.at(-1)?.entry ?? new Uint8Array(12);
  const at = 0x1a + new DataView(copy.buffer).getUint32(8, true);
  expect(out.subarray(at - 5, at)).toEqual(music(1).subarray(-5));
  // FANFARE plays channel 15 with instrument 84, past the 43 there are; so does its copy
  const slot15 = (m: Uint8Array, name: string) =>
    readMusic(m)
      .pieces.find((p) => p.name === name)
      ?.entry.subarray(0x50, 0x54);
  expect(slot15(music(1), "FANFARE")).toEqual(Uint8Array.of(1, 0x8a, 84, 0));
  expect(slot15(withMusicPieces(music(4), music(1), ["FANFARE"]), "FANFARE")).toEqual(
    Uint8Array.of(1, 0x8a, 84, 0),
  );
});

test("at most 127 pieces: a sound keeps the number in 7 bits", () => {
  let data = music(0);
  const take = (from: number) => {
    const have = new Set(musicPieces(data));
    data = withMusicPieces(
      data,
      music(from),
      musicPieces(music(from)).filter((p) => !have.has(p)),
    );
  };
  take(2);
  take(3);
  expect(musicPieces(data).length).toBeLessThanOrEqual(MAX_MUSIC_PIECES);
  expect(() => {
    take(4);
  }).toThrow(/at most 127/);
});

test("data without the signature is refused", () => {
  expect(() => musicPieces(new Uint8Array(0x40))).toThrow(MusicFormatError);
  expect(() => musicPieces(new Uint8Array(4))).toThrow(MusicFormatError);
});
