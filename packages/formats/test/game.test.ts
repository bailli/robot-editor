import assert from "node:assert/strict";

import { test } from "vitest";

import { readClassTable } from "../src/classes.ts";
import { readEventTable } from "../src/events.ts";
import { EPISODES, Game, eventTextsId, roomNamesId, withSoundLine } from "../src/game.ts";
import { HERO_ICON_CLASS, HERO_TYPE, readHeroStateIcons } from "../src/hero-states.ts";
import { withTextEntry } from "../src/texts.ts";
import { assertBytesEqual, exe } from "./data.ts";

const game = new Game(exe());

for (const episode of EPISODES) {
  test(`episode ${episode}: saving the unchanged rooms reproduces the exe`, () => {
    assertBytesEqual(game.withScene(episode, game.episode(episode).rooms), exe(), "exe");
  });
}

test("an edited cell survives saving and loading the exe", () => {
  const [first, ...rest] = game.episode(2).rooms;
  assert.ok(first);
  const base = first.base.slice();
  base[41] = 0x0105;
  const edited = game.withScene(2, [{ ...first, base }, ...rest]);
  const saved = new Game(edited);
  const offset = (g: Game) => g.resource("SCENE", 1204).dataOffset;
  assert.notEqual(offset(saved), offset(game), "the grown scene moved");
  assert.equal(saved.room(2, first.id).base[41], 0x0105);
  assert.deepEqual(saved.episode(2).rooms.slice(1), rest);
  assert.deepEqual(saved.episode(3).rooms, game.episode(3).rooms);
});

test("an edited text survives saving and loading the exe", () => {
  const id = roomNamesId(1);
  const source = game.textSource(id);
  assert.ok(source);
  const saved = new Game(game.withText(id, withTextEntry(source, 1043, ["Ä NEW START"])));
  assert.deepEqual(saved.roomName(1, 43), { room: 43, name: "Ä NEW START" });
  assert.deepEqual(
    saved.episodeTexts(1)?.entries.get(1042),
    game.episodeTexts(1)?.entries.get(1042),
  );
  assert.throws(() => game.withText(id, "1:\n€;"), RangeError);
});

test("withTileTypes: episode I's circuit pieces in episode III, all their data", () => {
  // III's free types 0x40, 0x59, 0x43 become I's LETTER 0x25, GATE 0x42 and BULB 0x43
  const types = new Map([
    [0x40, 0x25],
    [0x59, 0x42],
    [0x43, 0x43],
  ]);
  const saved = new Game(game.withTileTypes(3, 1, types));
  const [i, iii] = [game.episode(1), saved.episode(3)];
  for (const [to, of] of types) {
    assert.deepEqual(readClassTable(saved.image, 3)[to], readClassTable(game.image, 1)[of]);
    assert.deepEqual(iii.objects[to], i.objects[of]);
    assert.deepEqual(readEventTable(saved.image, 3)[to], readEventTable(game.image, 1)[of]);
    assert.deepEqual(saved.episodeTexts(3)?.entries.get(to), game.episodeTexts(1)?.entries.get(of));
  }
  assert.deepEqual(
    [59, 76, 77].map((id) => iii.classes.typeOfClass.get(id)),
    [0x40, 0x59, 0x43],
  );
  // III's first-take texts are in its own resource
  assert.equal(eventTextsId(3), 1320);
  assert.deepEqual(
    saved.texts(1320)?.entries.get(1800 + 0x59),
    game.episodeTexts(1)?.entries.get(1800 + 0x42),
  );
  assert.equal(saved.texts(1310)?.entries.get(1800 + 0x59), undefined);
  // sound lines: I's sound where III has the piece, else III's own (none for 0x59)
  const lines = (saved.textSource(1306) ?? "").split("\n").filter((l) => /^(64|67|89):/.test(l));
  assert.deepEqual(lines, ["64:!KLINGELI ;O_LETTER", "67:QFANFARE ;O_BULB", "89: ;O_GATE"]);
  assert.equal(saved.objectNames(3).get(0x59), "GATE");
  assert.deepEqual(saved.episode(3).rooms, game.episode(3).rooms);
  for (const e of [0, 1, 2, 4]) {
    assert.deepEqual(readClassTable(saved.image, e), readClassTable(game.image, e));
  }
});

test("withTileTypes: III's axe, hammer and bridle bring their icons and hero frames", () => {
  // III's 0x61, 0x62, 0x3e put the hero into states 10, 11, 12; III's icons for them are
  // frames 0-2 of its class-135 type (icons 1-3), which IV and I lack (icon 0)
  const tools = [0x61, 0x62, 0x3e];
  const iconType = (g: Game, e: number) =>
    g.episode(e).classes.typeOfClass.get(HERO_ICON_CLASS) ?? -1;
  const iii = game.episode(3).objects[iconType(game, 3)];
  for (const [episode, types, frames] of [
    [4, [0x03, 0x48, 0x6d], 4],
    [1, [0x4c, 0x4d, 0x4e], 7],
  ] as const) {
    assert.deepEqual(readHeroStateIcons(game.image, episode).slice(10), [0, 0, 0]);
    const saved = new Game(
      game.withTileTypes(episode, 3, new Map(types.map((to, k) => [to, tools[k] ?? 0]))),
    );
    const icons = saved.episode(episode).objects[iconType(saved, episode)];
    // appended after the episode's own frames, which stay
    assert.deepEqual(readHeroStateIcons(saved.image, episode).slice(10), [
      frames + 1,
      frames + 2,
      frames + 3,
    ]);
    assert.deepEqual(
      icons?.frames.slice(0, frames),
      game.episode(episode).objects[iconType(game, episode)]?.frames,
    );
    assert.deepEqual(icons?.frames.slice(frames), iii?.frames.slice(0, 3));
    // the other states' icons and the other episodes' stay
    assert.deepEqual(
      readHeroStateIcons(saved.image, episode).slice(0, 10),
      readHeroStateIcons(game.image, episode).slice(0, 10),
    );
    for (const e of EPISODES.filter((e) => e !== episode)) {
      assert.deepEqual(readHeroStateIcons(saved.image, e), readHeroStateIcons(game.image, e));
    }
  }
  // the hero: I's has frames 0-5 only and gets III's 6-11; IV's has 12 of its own
  const hero = (g: Game, e: number) => g.episode(e).objects[HERO_TYPE];
  const i = new Game(game.withTileTypes(1, 3, new Map([[0x4c, 0x61]])));
  assert.equal(hero(game, 1)?.frames.length, 6);
  assert.deepEqual(hero(i, 1)?.frames, [
    ...(hero(game, 1)?.frames ?? []),
    ...(hero(game, 3)?.frames.slice(6, 8) ?? []),
  ]);
  assert.deepEqual(hero(i, 1)?.colours, hero(game, 1)?.colours);
  const iv = new Game(game.withTileTypes(4, 3, new Map([[0x03, 0x62]])));
  assert.deepEqual(hero(iv, 4), hero(game, 4));
});

test("withTileTypes leaves a hero state's icon the episode has, and others alone", () => {
  // Junior's 0x14 (state 2) into I, which has state 2's icon
  const i = new Game(game.withTileTypes(1, 0, new Map([[0x4c, 0x14]])));
  assert.deepEqual(readHeroStateIcons(i.image, 1), readHeroStateIcons(game.image, 1));
  // a copy without hero states (III's timber) writes no icon and no shape beyond its own
  const iv = new Game(game.withTileTypes(4, 3, new Map([[0x03, 0x2b]])));
  assert.deepEqual(readHeroStateIcons(iv.image, 4), readHeroStateIcons(game.image, 4));
  for (const g of [i, iv]) {
    const e = g === i ? 1 : 4;
    assert.deepEqual(g.episode(e).objects.slice(0, 2), game.episode(e).objects.slice(0, 2));
  }
});

test("withTileTypes adds a sound line the episode lacks", () => {
  // III has no line for 0x73
  assert.ok(!/^115:/m.test(game.textSource(1306) ?? ""));
  const saved = new Game(game.withTileTypes(3, 1, new Map([[0x73, 0x25]])));
  assert.match(saved.textSource(1306) ?? "", /^115:!KLINGELI ;O_LETTER$/m);
});

test("withSounds: an entry's sound, its note kept, a missing line added", () => {
  // IV's 133 is E_PUT_OUT_FIRE; 197 has no line
  assert.equal(game.sound(4, 133), "!PUTOUTFI");
  assert.equal(game.sound(4, 197), "");
  const saved = new Game(
    game.withSounds(
      4,
      new Map([
        [133, "BEEPER"],
        [197, "!THIEFIRI"],
      ]),
    ),
  );
  const text = saved.textSource(1406) ?? "";
  assert.match(text, /^133:BEEPER ;E_PUT_OUT_FIRE$/m);
  assert.match(text, /^197:!THIEFIRI$/m);
  assert.equal(saved.sound(4, 197), "!THIEFIRI");
  assert.throws(() => game.withSounds(4, new Map([[197, "!ORACLE"]])), /no piece ORACLE/);
});

test("lackedPieces: the pieces sounds name that the episode lacks", () => {
  // I's thief bribe (entry 130) sounds !THIEFIRI, which IV has and Junior lacks
  assert.equal(game.sound(1, 130), "!THIEFIRI");
  assert.deepEqual(game.lackedPieces(4, [game.sound(1, 130)]), []);
  assert.deepEqual(game.lackedPieces(0, [game.sound(1, 130)]), ["THIEFIRI"]);
  // II's oracles and I's lit node: their pieces are only in II and III, I and II
  assert.deepEqual(game.lackedPieces(3, [game.sound(2, 135)]), []);
  for (const e of [0, 1, 4])
    assert.deepEqual(game.lackedPieces(e, [game.sound(2, 135)]), ["ORACLE"]);
  assert.deepEqual(game.lackedPieces(4, ["!BULBON", "BULBON", "", "PUTOUTFI"]), ["BULBON"]);
  // IV's 139 has an empty line
  assert.equal(game.sound(4, 139), "");
});

test("withMusicPieces: a piece another episode has, for a sound and a room's music", () => {
  const saved = new Game(game.withMusicPieces(4, 2, ["ORACLE"]));
  assert.deepEqual(saved.musicPieces(4), [...game.musicPieces(4), "ORACLE"]);
  assert.deepEqual(game.lackedPieces(4, ["!ORACLE"]), ["ORACLE"]);
  assert.deepEqual(saved.lackedPieces(4, ["!ORACLE"]), []);
  const sounded = new Game(saved.withSounds(4, new Map([[197, "!ORACLE"]])));
  assert.equal(sounded.sound(4, 197), "!ORACLE");
  for (const e of [0, 1, 2, 3]) assert.deepEqual(saved.musicPieces(e), game.musicPieces(e));
  assert.throws(() => game.withMusicPieces(4, 2, ["THIEFIRI"]), /has THIEFIRI already/);
  assert.throws(() => game.withMusicPieces(4, 2, ["NOSUCH"]), /no piece NOSUCH/);
});

test("withSoundLine takes the note literally, $ patterns included", () => {
  const table = "1:A ;x\n2:B ;y\n";
  assert.equal(withSoundLine(table, 2, "C", "$& $1 $$"), "1:A ;x\n2:C ;$& $1 $$\n");
  assert.equal(withSoundLine(table, 3, "D", "$&"), "1:A ;x\n2:B ;y\n3:D ;$&\n");
});
