import {
  ACTOR_LOAD_METHODS,
  BOMB_LOAD_METHOD,
  type EpisodeClasses,
  type Game,
  HATCHING_LOAD_METHODS,
  LOGIC_CELL,
  type Room,
  SAND_DESCRIBE_METHOD,
  SAND_SCORPION_STATES,
  START_ROOMS,
  resolveCell,
} from "@robot/formats";

/** Room tags holding the script source (6/1) and the compiled script (6/2). */
const isScript = (kind: number, value: number) => kind === 6 && (value === 1 || value === 2);

/** Logic records that let creatures appear: spawners (5) and creatures (7), records.ts. */
/** Logic records that let actors appear: spawners (5), creatures (7), travelling actors (8). */
const ACTOR_RECORDS = new Set([5, 7, 8]);

/**
 * The room without anything that moves or could kill the hero before a screenshot (a
 * death's message box would cover the room): cells whose class becomes an actor on
 * entering (robots, androids, snakes, …, see ACTOR_LOAD_METHODS), hatcheries and other
 * delayed creature sources (HATCHING_LOAD_METHODS) and bombs (they release robots) become
 * empty, sand heaps hiding scorpions plain sand; records that let actors appear are
 * removed and their cells show what the records showed.
 */
export function calmRoom(room: Room, classes: EpisodeClasses): Room {
  const removed = room.records.filter((r) => ACTOR_RECORDS.has(r.data[0]));
  // actor records all have slot 0xff and no logic cell refers to them
  const removedSlots = new Set(removed.map((r) => r.slot).filter((slot) => slot !== 0xff));
  const calm = (cell: number): number => {
    const cls = classes.classes.get(cell & 0xff);
    const load = cls?.loadMethod ?? 0;
    if (cls?.describeMethod === SAND_DESCRIBE_METHOD && SAND_SCORPION_STATES.has(cell >> 8)) {
      return cell & 0xff; // plain sand instead of a heap hiding a scorpion
    }
    if (ACTOR_LOAD_METHODS.has(load) || HATCHING_LOAD_METHODS.has(load)) return 0;
    if (load === BOMB_LOAD_METHOD) return 0;
    if ((cell & 0xff) === LOGIC_CELL && removedSlots.has(cell >> 8)) {
      return calm(resolveCell(room, cell));
    }
    return cell;
  };
  return {
    ...room,
    base: room.base.map(calm),
    overlay: room.overlay.map(calm),
    records: room.records.filter((r) => !removed.includes(r)),
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
  const target = calmRoom(game.room(episode, roomId), game.episode(episode).classes);
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
