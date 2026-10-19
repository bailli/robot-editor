import { type Game, LOGIC_CELL, type Room, START_ROOMS, resolveCell } from "@robot/formats";

/** Room tags holding the script source (6/1) and the compiled script (6/2). */
const isScript = (kind: number, value: number) => kind === 6 && (value === 1 || value === 2);

/**
 * Tile types of the enemies placed in maps: 2 robots or animals ("Diesen üblen Roboter…"),
 * 0x2d androids (episode III: the poison snake).
 */
const ENEMIES = new Set([2, 0x2d]);
/** Logic records that let creatures appear: spawners (5) and creatures (7), records.ts. */
const CREATURE_RECORDS = new Set([5, 7]);

/**
 * The room without its enemies, so that a screenshot is not interrupted by the hero's
 * death (its message box would cover the room): enemy cells become empty, spawner and creature
 * records are removed and their cells show what the records showed.
 */
export function calmRoom(room: Room): Room {
  const removed = new Set(
    room.records.filter((r) => CREATURE_RECORDS.has(r.data[0])).map((r) => r.slot),
  );
  const calm = (cell: number) => {
    if (ENEMIES.has(cell & 0xff)) return 0;
    if ((cell & 0xff) === LOGIC_CELL && removed.has(cell >> 8)) return resolveCell(room, cell);
    return cell;
  };
  return {
    ...room,
    base: room.base.map(calm),
    overlay: room.overlay.map(calm),
    records: room.records.filter((r) => !removed.has(r.slot)),
  };
}

/**
 * A copy of the exe in which `episode` starts in a room with the content of `roomId`:
 * its scene holds only rooms 1 and 2 (title screens) and, in the start room's slot, the
 * map and tags of the wanted room without its scripts (they evaluate game state and
 * could change the room) and without enemies (calmRoom). The smaller scene is written
 * over the original in place.
 */
export function patchedExe(game: Game, episode: number, roomId: number): Uint8Array {
  const start = START_ROOMS[episode];
  if (start === undefined) throw new RangeError(`no episode ${episode}`);
  const target = calmRoom(game.room(episode, roomId));
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
