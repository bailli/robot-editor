import {
  type EpisodeClasses,
  type Game,
  type LogicRecord,
  type Room,
  SCRIPT_TAG,
  START_ROOMS,
  ScriptPart,
  backdropRoom,
  cellActorSource,
  parsePe,
  readEpisodeStart,
  resolveCell,
  roomActors,
  withEpisodeStart,
} from "@robot/formats";

/** Room tags holding the script source and the compiled script. */
const isScript = (kind: number, value: number) =>
  kind === SCRIPT_TAG && (value === ScriptPart.SOURCE || value === ScriptPart.COMPILED);

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
      // what the logic cell shows, following records that show logic cells
      layer[actor.cell] = calm(resolveCell(room, layer[actor.cell] ?? 0));
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
 * over the original in place. A room with a backdrop (backdropRoom) keeps its id and its
 * backdrop room, made calm as well, and the episode starts in it (withEpisodeStart).
 */
export function patchedExe(game: Game, episode: number, roomId: number): Uint8Array {
  const start = START_ROOMS[episode];
  if (start === undefined) throw new RangeError(`no episode ${episode}`);
  const ep = game.episode(episode);
  const calm = (room: Room): Room => {
    const target = calmRoom(room, ep.classes);
    return { ...target, tags: target.tags.filter((t) => !isScript(t.kind, t.value)) };
  };
  const target = game.room(episode, roomId);
  const backdrop = backdropRoom(episode, target, ep.rooms, ep.classes);
  const keep = ep.rooms.filter((r) => r.id === 1 || r.id === 2);
  if (backdrop) {
    const rooms = [
      ...keep.filter((r) => r.id !== target.id && r.id !== backdrop.id),
      calm(target),
      calm(backdrop),
    ];
    const scene = game.withScene(
      episode,
      rooms.sort((a, b) => a.id - b.id),
    );
    const image = parsePe(scene);
    return withEpisodeStart(image, episode, { ...readEpisodeStart(image, episode), room: roomId });
  }
  return game.withScene(
    episode,
    [...keep.filter((r) => r.id !== start), { ...calm(target), id: start }].sort(
      (a, b) => a.id - b.id,
    ),
  );
}
