import assert from "node:assert/strict";

import { test } from "vitest";

import { EPISODES, Game, roomNamesId } from "../src/game.ts";
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
