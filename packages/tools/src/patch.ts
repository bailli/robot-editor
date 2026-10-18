import { type Game, type Room, START_ROOMS } from "@robot/formats";

/** Room tags holding the script source (6/1) and the compiled script (6/2). */
const isScript = (kind: number, value: number) => kind === 6 && (value === 1 || value === 2);

/**
 * A copy of the exe in which `episode` starts in a room with the content of `roomId`:
 * its scene holds only rooms 1 and 2 (title screens) and, in the start room's slot, the
 * map and tags of the wanted room without its scripts (they evaluate game state and
 * could change the room). The smaller scene is written over the original in place.
 */
export function patchedExe(game: Game, episode: number, roomId: number): Uint8Array {
  const start = START_ROOMS[episode];
  if (start === undefined) throw new RangeError(`no episode ${episode}`);
  const target = game.room(episode, roomId);
  const room: Room = {
    ...target,
    id: start,
    tags: target.tags.filter((t) => !isScript(t.kind, t.value)),
  };
  const keep = game
    .episode(episode)
    .rooms.filter((r) => (r.id === 1 || r.id === 2) && r.id !== start);
  return game.withScene(
    episode,
    [...keep, room].sort((a, b) => a.id - b.id),
  );
}
