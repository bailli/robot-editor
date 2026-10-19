import {
  type EpisodeClasses,
  type Game,
  type LogicRecord,
  type Room,
  START_ROOMS,
  cellActorSource,
  recordCell,
  roomActors,
} from "@robot/formats";

/** Room tags holding the script source (6/1) and the compiled script (6/2). */
const isScript = (kind: number, value: number) => kind === 6 && (value === 1 || value === 2);

/** Logic records that let creatures appear: spawners (5) and creatures (7), records.ts. */
/**
 * The room without anything that moves or could kill the hero before a screenshot (a
 * death's message box would cover the room): every actor source (roomActors) goes. Actor
 * tiles, hatcheries and bombs become empty, scorpion sand plain sand; records that let
 * actors appear are removed and their cells show what the records showed.
 */
export function calmRoom(room: Room, classes: EpisodeClasses): Room {
  const base = room.base.slice();
  const overlay = room.overlay.slice();
  const removed = new Set<LogicRecord>();
  const calm = (cell: number): number => {
    const source = cellActorSource(cell, classes);
    return source === "scorpions" ? cell & 0xff : source ? 0 : cell;
  };
  for (const actor of roomActors(room, classes)) {
    const layer = actor.layer === "base" ? base : overlay;
    if (actor.record) {
      removed.add(actor.record);
      layer[actor.cell] = calm(recordCell(actor.record));
    } else {
      layer[actor.cell] = calm(layer[actor.cell] ?? 0);
    }
  }
  return { ...room, base, overlay, records: room.records.filter((r) => !removed.has(r)) };
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
