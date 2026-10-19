import { expect, test } from "vitest";

import { roomActors, scriptActors } from "../src/actors.ts";
import { roomScript } from "../src/exits.ts";
import { EPISODES, Game } from "../src/game.ts";
import { exe } from "./data.ts";

const game = new Game(exe());

const count = (episode: number, room: number) => {
  const counts: Record<string, number> = {};
  for (const a of roomActors(game.room(episode, room), game.episode(episode).classes)) {
    const key = `${a.source} 0x${(a.type ?? 0).toString(16)}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

test("the actors of a room: robots, androids, the worm and a bomb", () => {
  expect(count(2, 123)).toEqual({ "tile 0x2": 20, "tile 0x2d": 4, "tile 0x37": 1, "bomb 0x13": 1 });
});

test("records let robots, natives and travelling actors appear", () => {
  const classes = game.episode(4).classes;
  const spawners = roomActors(game.room(4, 341), classes).filter((a) => a.source === "spawner");
  expect(spawners).toHaveLength(8);
  expect(spawners[0]?.type).toBe(2); // episode IV's robots (class 189)
  expect(spawners[0]?.radius).toBeGreaterThan(0);

  const natives = roomActors(game.room(3, 11), game.episode(3).classes).filter(
    (a) => a.source === "creature",
  );
  expect(natives.map((a) => a.type)).toEqual([0x2c, 0x2c, 0x2c]); // "freundliche Eingeborene"

  const travelling = roomActors(game.room(0, 31), game.episode(0).classes).find(
    (a) => a.source === "travelling",
  );
  expect(travelling?.target).toEqual({ room: 41, x: 14, y: 3 });
});

test("scripts scatter robots, androids and bombs", () => {
  expect(scriptActors(roomScript(game.room(2, 123)))).toEqual([
    { name: "ALIEN", min: 8, max: 15, conditional: true },
    { name: "ANDROID", min: 2, max: 4, conditional: true },
    { name: "BOMB", min: 1, max: 1, conditional: true },
  ]);
});

test("actors in every episode", () => {
  expect(
    EPISODES.map((episode) => {
      const counts: Record<string, number> = {};
      for (const room of game.episode(episode).rooms) {
        for (const a of roomActors(room, game.episode(episode).classes)) {
          counts[a.source] = (counts[a.source] ?? 0) + 1;
        }
      }
      return counts;
    }),
  ).toMatchSnapshot();
});
