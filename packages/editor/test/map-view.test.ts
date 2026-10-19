import { expect, test } from "vitest";

import { connections } from "../src/exits-view.ts";
import { adjacent, mapBadges, mapLink, mapPosition } from "../src/map-view.ts";
import { loadGame } from "./game.ts";

const game = await loadGame();
const room = (episode: number, id: number) => game.room(episode, id);

test("rooms sit on the grid their ids give", () => {
  expect(mapPosition(147)).toEqual({ floor: 1, row: 4, column: 7 });
  expect(adjacent(43, "east")).toBe(44);
  expect(adjacent(43, "north")).toBe(33);
  // the neighbour across a row or floor is not drawn next to the room
  expect(adjacent(40, "west")).toBeUndefined();
  expect(adjacent(103, "north")).toBeUndefined();
});

test("links say what the exits byte, the exit tiles and the script do", () => {
  // episode I room 43: east open to 44; west closed, opened by the script at a high score
  expect(mapLink(room(1, 43), "east", room(1, 44)).state).toBe("open");
  const west = mapLink(room(1, 43), "west", room(1, 42));
  expect(west.state).toBe("scripted");
  expect(west.title).toMatch(/exits byte "none".*RoomWest = 42 \(depending on the game state\)/);
  // room 21's south edge has an exit tile that does not arrive on one of room 31
  expect(mapLink(room(1, 21), "south", room(1, 31)).state).toBe("broken");
});

test("badges show the links that are not to a grid neighbour", () => {
  const ids = new Set(game.episode(3).rooms.map((r) => r.id));
  const hut = room(3, 47); // its door leads inside, room 147
  const badges = mapBadges(hut, connections(hut, ids, game.episode(3).classes));
  expect(badges.map((b) => b.text)).toContain("door in 147");
});
