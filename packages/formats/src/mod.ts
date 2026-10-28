/**
 * Mods: what a fan episode changes, applied to the pristine exe (STATUS, "The mod format").
 *
 * A mod is a set of keyed changes, each key at most once, applied in a fixed order of
 * kinds (a later kind wins over an earlier one):
 *   1. tileTypes  (episode, target type)  tile types from another episode (withTileTypes)
 *   2. events     (episode, entry)        an event table entry's id, points and sound
 *   3. code       (address)               bytes written where the exe holds `expect`
 *   4. dealer     (episode)               the dealer's goods and how many shown (withDealer)
 *   5. copyTexts  (resource, entry)       a text entry copied from another one of the exe
 *      texts      (resource, entry)       a text entry set or removed (withTextEntry)
 *   6. rooms      (episode, room id)      a room replaced, added or removed (withScene)
 *   7. start      (episode)               where the episode starts (withEpisodeStart)
 *   8. rucksack   (episode)               the rucksack's capacity (withRucksack)
 *   9. flags      (episode)               the episode's flags (withEpisodeFlags)
 *  10. backdrop   (episode)               the room drawn behind (withBackdropRule)
 *  11. moves      (episode)               diagonal moves or not (withDiagonalMoves)
 * copyTexts and texts share their keys: an entry is either copied or written. Copies read
 * the exe as kinds 1-3 left it, so the mod carries no text of the game's own. The event
 * tables are full: a new event takes over an entry the episode never uses.
 * Applying first compiles the mod against the pristine exe (checked by its sha256) into a
 * patch: byte writes outside the resources and whole replaced resources. The exe writer
 * (applyPatch) and, later, the proxy as an in-memory loader apply only that patch.
 *
 * The file is JSON: format, name, author, description, base { sha256 }, changes with one
 * array per kind; code and flags as hex strings, the dealer's goods as [class, state, price], rooms
 * as base64 of serializeRoom (null removes).
 */
import { TILE_TYPES } from "./classes.ts";
import { type Dealer, dealerProblem, withDealer } from "./dealer.ts";
import { withEpisodeFlags } from "./episode-flags.ts";
import {
  BACKDROP_RULES,
  type BackdropRule,
  withBackdropRule,
  withDiagonalMoves,
} from "./episode-methods.ts";
import { fileOffset } from "./episode.ts";
import {
  EVENT_IDS_END,
  FIRST_EVENT_ENTRY,
  FIRST_EVENT_ID,
  eventTableLength,
  readEventTable,
  withEventEntries,
} from "./events.ts";
import { EPISODES, Game } from "./game.ts";
import { DIRECTORY_RESOURCE, type PeImage, parsePe } from "./pe.ts";
import { findResource, readResources, replaceResource } from "./resources.ts";
import {
  ROOM_HEIGHT,
  ROOM_WIDTH,
  type Room,
  SceneFormatError,
  parseRoom,
  serializeRoom,
} from "./scene.ts";
import { sha256 } from "./sha256.ts";
import { type EpisodeStart, MAX_RUCKSACK, withEpisodeStart, withRucksack } from "./start.ts";
import { parseTexts, textEntryProblem, withTextEntry } from "./texts.ts";

export const MOD_FORMAT = 1;
/** Room ids have 10 bits (records and exits hold them so). */
const MAX_ROOM_ID = 0x3ff;

export interface TileTypesChange {
  episode: number;
  from: number;
  /** [target type, source type] pairs. */
  types: readonly (readonly [to: number, of: number])[];
}

export interface EventChange {
  episode: number;
  /** The entry: a tile type below 128 (its first take), an event from 128 on. */
  entry: number;
  /**
   * From entry 128 on 0 (none) or FIRST_EVENT_ID to EVENT_IDS_END - 1, once per table; a
   * tile type's entry below FIRST_EVENT_ID (the originals': at most 255, mostly its
   * class id), which cannot collide with an event's.
   */
  id: number;
  points: number;
  /**
   * Its sound, line `entry` of the sound table (Game.withSounds): a MUSIC piece of the
   * episode, `!` before it sets bit 7. Without it the line stays.
   */
  sound?: string;
}

export interface CodeChange {
  va: number;
  /** What the exe holds there as kinds 1-2 leave it; the change is refused otherwise. */
  expect: Uint8Array;
  bytes: Uint8Array;
}

export interface DealerChange extends Dealer {
  episode: number;
}

export interface CopyTextsChange {
  /** The CRUNCHED resource the entries go to. */
  resource: number;
  /** The CRUNCHED resource they come from (it may be `resource`). */
  from: number;
  /** [target entry, source entry] pairs. */
  entries: readonly (readonly [to: number, of: number])[];
}

export interface TextChange {
  /** A CRUNCHED resource id (e.g. textsId, eventTextsId, roomNamesId). */
  resource: number;
  entry: number;
  /** null removes the entry. */
  variants: readonly string[] | null;
}

export interface RoomChange {
  episode: number;
  id: number;
  /** null removes the room. */
  room: Room | null;
}

export interface StartChange extends EpisodeStart {
  episode: number;
}

export interface RucksackChange {
  episode: number;
  /** Its slots; the weight it holds stays below (1 to MAX_RUCKSACK). */
  capacity: number;
}

export interface FlagsChange {
  episode: number;
  /** The whole word the constructor sets (episode-flags.ts). */
  flags: number;
}

export interface BackdropChange {
  episode: number;
  rule: BackdropRule;
}

export interface MovesChange {
  episode: number;
  /** Whether the hero walks diagonally (Home, PgUp, End, PgDn). */
  diagonal: boolean;
}

export interface ModChanges {
  tileTypes: readonly TileTypesChange[];
  events: readonly EventChange[];
  code: readonly CodeChange[];
  dealer: readonly DealerChange[];
  copyTexts: readonly CopyTextsChange[];
  texts: readonly TextChange[];
  rooms: readonly RoomChange[];
  start: readonly StartChange[];
  rucksack: readonly RucksackChange[];
  flags: readonly FlagsChange[];
  backdrop: readonly BackdropChange[];
  moves: readonly MovesChange[];
}

export interface Mod {
  name: string;
  author: string;
  description: string;
  /** The sha256 of the pristine exe the mod applies to. */
  base: string;
  changes: ModChanges;
}

export interface PatchWrite {
  va: number;
  bytes: Uint8Array;
}

export interface PatchResource {
  type: number | string;
  name: number | string;
  language: number;
  data: Uint8Array;
}

/** A mod compiled against the pristine exe (compileMod). */
export interface ModPatch {
  /** The sha256 of the pristine exe it was compiled against; applyPatch refuses any other. */
  base: string;
  writes: PatchWrite[];
  resources: PatchResource[];
}

export class ModError extends Error {
  override name = "ModError";
}

export const NO_CHANGES: ModChanges = {
  tileTypes: [],
  events: [],
  code: [],
  dealer: [],
  copyTexts: [],
  texts: [],
  rooms: [],
  start: [],
  rucksack: [],
  flags: [],
  backdrop: [],
  moves: [],
};

/** A mod without changes for the given exe. */
export function emptyMod(exe: Uint8Array, name = ""): Mod {
  return { name, author: "", description: "", base: sha256(exe), changes: NO_CHANGES };
}

// --- checking ---------------------------------------------------------------------

const isInt = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;

function need(ok: boolean, where: string, message: string): asserts ok {
  if (!ok) throw new ModError(`${where}: ${message}`);
}

/** What `make` gives; its refusals (RangeError, SceneFormatError) as a ModError at `where`. */
function refusing<T>(where: string, make: () => T): T {
  try {
    return make();
  } catch (error) {
    if (error instanceof RangeError || error instanceof SceneFormatError)
      need(false, where, error.message);
    throw error;
  }
}

function episodeOk(episode: number, where: string): void {
  need((EPISODES as readonly number[]).includes(episode), where, `no episode ${episode}`);
}

/** Throws a ModError naming the change if any change is invalid or a key repeats. */
export function checkMod(mod: Mod): void {
  need(/^[0-9a-f]{64}$/.test(mod.base), "base", "not a sha256 (64 lowercase hex digits)");
  const {
    tileTypes,
    events,
    code,
    dealer,
    copyTexts,
    texts,
    rooms,
    start,
    rucksack,
    flags,
    backdrop,
    moves,
  } = mod.changes;
  const keys = new Set<string>();
  const once = (key: string, where: string) => {
    need(!keys.has(key), where, "changed twice");
    keys.add(key);
  };
  tileTypes.forEach((c, i) => {
    const where = `tileTypes[${i}]`;
    episodeOk(c.episode, where);
    episodeOk(c.from, where);
    need(c.from !== c.episode, where, "copies from its own episode");
    need(c.types.length > 0, where, "no types");
    for (const [to, of] of c.types) {
      need(
        isInt(to, 0, TILE_TYPES - 1) && isInt(of, 0, TILE_TYPES - 1),
        where,
        `types ${to}, ${of}`,
      );
      once(`type ${c.episode} ${to}`, `${where} (type ${to})`);
    }
  });
  // copies read the exe as the earlier ones left it: a source that is a copy itself would
  // carry a third episode's type (the editor refuses it likewise)
  tileTypes.forEach((c, i) => {
    for (const [, of] of c.types) {
      need(
        !keys.has(`type ${c.from} ${of}`),
        `tileTypes[${i}] (type ${of})`,
        `copies type ${of} of episode ${c.from}, which is a copy itself`,
      );
    }
  });
  events.forEach((c, i) => {
    const where = `events[${i}] (episode ${c.episode}, entry ${c.entry})`;
    episodeOk(c.episode, where);
    need(isInt(c.entry, 0, eventTableLength(c.episode) - 1), where, "no such entry");
    const ids =
      c.entry < FIRST_EVENT_ENTRY
        ? isInt(c.id, 0, FIRST_EVENT_ID - 1)
        : c.id === 0 || isInt(c.id, FIRST_EVENT_ID, EVENT_IDS_END - 1);
    need(
      ids,
      where,
      c.entry < FIRST_EVENT_ENTRY
        ? `id ${c.id} (a tile type's entry has 0-${FIRST_EVENT_ID - 1}, as the game's: from ${FIRST_EVENT_ID} on ids belong to events)`
        : `id ${c.id} (from entry 128 on 0 or ${FIRST_EVENT_ID}-${EVENT_IDS_END - 1})`,
    );
    need(isInt(c.points, -0x80000000, 0x7fffffff), where, `points ${c.points}`);
    need(
      c.sound === undefined || /^!?[^\s;!][^\s;]*$/.test(c.sound),
      where,
      `sound ${JSON.stringify(c.sound)} (a piece's name)`,
    );
    once(`event ${c.episode} ${c.entry}`, where);
  });
  const ranges: [number, number, string][] = [];
  code.forEach((c, i) => {
    const where = `code[${i}]`;
    need(isInt(c.va, 0, 0xffffffff), where, `address ${c.va}`);
    need(c.bytes.length > 0, where, "no bytes");
    need(c.expect.length === c.bytes.length, where, "expect and bytes differ in length");
    ranges.push([c.va, c.va + c.bytes.length, where]);
  });
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++) {
    const [[, end, before], [va, , where]] = [ranges[i - 1], ranges[i]];
    need(end <= va, where, `overlaps ${before}`);
  }
  dealer.forEach((c, i) => {
    const where = `dealer[${i}] (episode ${c.episode})`;
    episodeOk(c.episode, where);
    // the room the table has is checked against the exe (withDealer)
    const problem = dealerProblem(c, Infinity);
    need(problem === undefined, where, problem ?? "");
    once(`dealer ${c.episode}`, where);
  });
  const textId = (v: number) => isInt(v, 0, 0xffff);
  copyTexts.forEach((c, i) => {
    const where = `copyTexts[${i}]`;
    need(textId(c.resource) && textId(c.from), where, "bad resource id");
    need(c.entries.length > 0, where, "no entries");
    for (const [to, of] of c.entries) {
      need(textId(to) && textId(of), where, `entries ${to}, ${of}`);
      need(c.from !== c.resource || to !== of, where, `copies entry ${to} onto itself`);
      once(`text ${c.resource} ${to}`, `${where} (${c.resource}:${to})`);
    }
  });
  texts.forEach((c, i) => {
    const where = `texts[${i}] (${c.resource}:${c.entry})`;
    need(textId(c.resource) && textId(c.entry), where, "bad id");
    need(c.variants === null || c.variants.length > 0, where, "no variants (null removes)");
    const problem = c.variants?.map(textEntryProblem).find((p) => p !== undefined);
    need(problem === undefined, where, problem ?? "");
    once(`text ${c.resource} ${c.entry}`, where);
  });
  rooms.forEach((c, i) => {
    const where = `rooms[${i}] (episode ${c.episode}, room ${c.id})`;
    episodeOk(c.episode, where);
    need(isInt(c.id, 1, MAX_ROOM_ID), where, `room ids go from 1 to ${MAX_ROOM_ID}`);
    need(c.room === null || c.room.id === c.id, where, `holds room ${c.room?.id ?? ""}`);
    once(`room ${c.episode} ${c.id}`, where);
  });
  start.forEach((c, i) => {
    const where = `start[${i}] (episode ${c.episode})`;
    episodeOk(c.episode, where);
    need(isInt(c.room, 1, MAX_ROOM_ID), where, `room ${c.room}`);
    need(isInt(c.x, 0, ROOM_WIDTH - 1) && isInt(c.y, 0, ROOM_HEIGHT - 1), where, "cell");
    once(`start ${c.episode}`, where);
  });
  rucksack.forEach((c, i) => {
    const where = `rucksack[${i}] (episode ${c.episode})`;
    episodeOk(c.episode, where);
    need(isInt(c.capacity, 1, MAX_RUCKSACK), where, `capacity ${c.capacity} (1-${MAX_RUCKSACK})`);
    once(`rucksack ${c.episode}`, where);
  });
  flags.forEach((c, i) => {
    const where = `flags[${i}] (episode ${c.episode})`;
    episodeOk(c.episode, where);
    need(isInt(c.flags, 0, 0xffffffff), where, `flags ${c.flags} (32 bits)`);
    once(`flags ${c.episode}`, where);
  });
  backdrop.forEach((c, i) => {
    const where = `backdrop[${i}] (episode ${c.episode})`;
    episodeOk(c.episode, where);
    need((BACKDROP_RULES as readonly string[]).includes(c.rule), where, `rule ${c.rule}`);
    once(`backdrop ${c.episode}`, where);
  });
  moves.forEach((c, i) => {
    const where = `moves[${i}] (episode ${c.episode})`;
    episodeOk(c.episode, where);
    need(typeof c.diagonal === "boolean", where, "diagonal is not true or false");
    once(`moves ${c.episode}`, where);
  });
}

// --- applying -----------------------------------------------------------------------

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const byKeys =
  <T>(...keys: ((c: T) => number)[]) =>
  (a: T, b: T) =>
    keys.reduce((order, key) => order || key(a) - key(b), 0);

/**
 * The changes in key order (that of the file): the result must not depend on the order
 * they were made in (new text entries and sound lines are appended, for example).
 */
function canonical(changes: ModChanges): ModChanges {
  return {
    tileTypes: changes.tileTypes
      .map((c) => ({ ...c, types: c.types.toSorted(byKeys(([to]) => to)) }))
      .toSorted(
        byKeys(
          (c) => c.episode,
          (c) => c.types[0]?.[0] ?? 0,
        ),
      ),
    events: changes.events.toSorted(
      byKeys(
        (c) => c.episode,
        (c) => c.entry,
      ),
    ),
    code: changes.code.toSorted(byKeys((c) => c.va)),
    dealer: changes.dealer.toSorted(byKeys((c) => c.episode)),
    copyTexts: changes.copyTexts
      .map((c) => ({ ...c, entries: c.entries.toSorted(byKeys(([to]) => to)) }))
      .toSorted(
        byKeys(
          (c) => c.resource,
          (c) => c.entries[0]?.[0] ?? 0,
        ),
      ),
    texts: changes.texts.toSorted(
      byKeys(
        (c) => c.resource,
        (c) => c.entry,
      ),
    ),
    rooms: changes.rooms.toSorted(
      byKeys(
        (c) => c.episode,
        (c) => c.id,
      ),
    ),
    start: changes.start.toSorted(byKeys((c) => c.episode)),
    rucksack: changes.rucksack.toSorted(byKeys((c) => c.episode)),
    flags: changes.flags.toSorted(byKeys((c) => c.episode)),
    backdrop: changes.backdrop.toSorted(byKeys((c) => c.episode)),
    moves: changes.moves.toSorted(byKeys((c) => c.episode)),
  };
}

/** The mod's changes applied through the editing functions, in the order of kinds. */
function build(image: PeImage, changes: ModChanges): Uint8Array {
  let game = new Game(image.data);
  for (const c of changes.tileTypes) {
    const where = `tileTypes (episode ${c.episode} from ${c.from})`;
    game = new Game(refusing(where, () => game.withTileTypes(c.episode, c.from, new Map(c.types))));
  }
  for (const episode of new Set(changes.events.map((c) => c.episode))) {
    const entries = changes.events.filter((c) => c.episode === episode);
    game = new Game(
      withEventEntries(game.image, episode, new Map(entries.map((c) => [c.entry, c]))),
    );
    // an id maps to one entry (the constructor's last one would win)
    const seen = new Map<number, number>();
    readEventTable(game.image, episode).forEach(({ id }, n) => {
      if (id < FIRST_EVENT_ID) return; // class ids and 0 share no key with events
      const other = seen.get(id);
      need(
        other === undefined,
        `events (episode ${episode})`,
        `entries ${other} and ${n} both have id ${id}`,
      );
      seen.set(id, n);
    });
    const sounds = entries.flatMap((c) =>
      c.sound === undefined ? [] : [[c.entry, c.sound] as const],
    );
    if (sounds.length > 0) {
      const where = `events (episode ${episode})`;
      game = new Game(refusing(where, () => game.withSounds(episode, new Map(sounds))));
    }
  }
  if (changes.code.length > 0) {
    const out = game.image.data.slice();
    changes.code.forEach((c, i) => {
      const where = `code[${i}] at 0x${c.va.toString(16)}`;
      let at = 0;
      try {
        at = fileOffset(game.image, c.va, c.bytes.length);
      } catch {
        need(false, where, "no initialised data there");
      }
      const found = out.subarray(at, at + c.bytes.length);
      need(hex(found) === hex(c.expect), where, `the exe holds ${hex(found)}`);
      out.set(c.bytes, at);
    });
    game = new Game(out);
  }
  for (const c of changes.dealer) {
    const { classes } = game.episode(c.episode);
    const where = `dealer (episode ${c.episode})`;
    game = new Game(refusing(where, () => withDealer(game.image, c.episode, c, classes)));
  }
  // copies read the texts before any is changed, then go with the others in key order
  const copied = changes.copyTexts.flatMap((c, i) => {
    const source = game.texts(c.from)?.entries;
    need(source !== undefined, `copyTexts[${i}] (from ${c.from})`, "no such text resource");
    return c.entries.map(([entry, of]) => {
      const variants = source.get(of);
      need(variants !== undefined, `copyTexts[${i}] (${c.from}:${of})`, "no such entry");
      return { resource: c.resource, entry, variants };
    });
  });
  const texts = [...copied, ...changes.texts].sort(
    byKeys(
      (c) => c.resource,
      (c) => c.entry,
    ),
  );
  for (const resource of new Set(texts.map((c) => c.resource))) {
    const text = game.textSource(resource);
    need(text !== undefined, `texts (${resource})`, "no such text resource");
    const set = texts.filter((t) => t.resource === resource);
    const where = `texts (${resource})`;
    game = new Game(refusing(where, () => game.withText(resource, withTextChanges(text, set))));
  }
  for (const episode of new Set(changes.rooms.map((c) => c.episode))) {
    const set = changes.rooms.filter((r) => r.episode === episode);
    const rooms = withRoomChanges(game.episode(episode).rooms, set);
    game = new Game(refusing(`rooms (episode ${episode})`, () => game.withScene(episode, rooms)));
  }
  let data = game.image.data;
  for (const { episode, ...start } of changes.start) {
    data = withEpisodeStart(parsePe(data), episode, start);
  }
  for (const { episode, capacity } of changes.rucksack) {
    data = withRucksack(parsePe(data), episode, capacity);
  }
  for (const { episode, flags } of changes.flags) {
    data = withEpisodeFlags(parsePe(data), episode, flags);
  }
  for (const { episode, rule } of changes.backdrop) {
    data = withBackdropRule(parsePe(data), episode, rule);
  }
  for (const { episode, diagonal } of changes.moves) {
    data = withDiagonalMoves(parsePe(data), episode, diagonal);
  }
  return data;
}

/** A text resource (as decoded) with the changes' entries set or removed, in their order. */
export function withTextChanges(text: string, changes: readonly TextChange[]): string {
  return changes.reduce((t, c) => withTextEntry(t, c.entry, c.variants ?? undefined), text);
}

/**
 * An episode's rooms with the changes made: rooms replaced in place; once a room is
 * added or removed, sorted by id, as the editor keeps them.
 */
export function withRoomChanges(rooms: readonly Room[], changes: readonly RoomChange[]): Room[] {
  const out = [...rooms];
  let reordered = false;
  for (const c of changes) {
    const at = out.findIndex((r) => r.id === c.id);
    if (c.room === null) {
      need(at >= 0, `rooms (episode ${c.episode}, room ${c.id})`, "removes a missing room");
      out.splice(at, 1);
      reordered = true;
    } else if (at >= 0) {
      out[at] = c.room;
    } else {
      out.push(c.room);
      reordered = true;
    }
  }
  if (reordered) out.sort((a, b) => a.id - b.id);
  return out;
}

/** What turns the rooms `base` into `rooms`: rooms that differ byte for byte, added, removed. */
export function roomChanges(
  episode: number,
  base: readonly Room[],
  rooms: readonly Room[],
): RoomChange[] {
  const before = new Map(base.map((r) => [r.id, r]));
  const changed = rooms.flatMap((room) => {
    const old = before.get(room.id);
    return old && (old === room || sameBytes(serializeRoom(old), serializeRoom(room)))
      ? []
      : [{ episode, id: room.id, room }];
  });
  const ids = new Set(rooms.map((r) => r.id));
  const removed = base.flatMap((r) => (ids.has(r.id) ? [] : [{ episode, id: r.id, room: null }]));
  return [...changed, ...removed].sort(byKeys((c) => c.id));
}

/** What turns the text resource `base` into `text`: entries set, added or removed. */
export function textChanges(resource: number, base: string, text: string): TextChange[] {
  const [before, after] = [parseTexts(base).entries, parseTexts(text).entries];
  const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
    a?.length === b?.length && (a ?? []).every((v, i) => v === b?.[i]);
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort((a, b) => a - b)
    .flatMap((entry) => {
      const variants = after.get(entry);
      return same(before.get(entry), variants)
        ? []
        : [{ resource, entry, variants: variants ?? null }];
    });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The section holding the resources (the last one; replaceResource grows it). */
function resourceSection(image: PeImage) {
  const dir = image.dataDirectories.at(DIRECTORY_RESOURCE);
  return image.sections.find(
    (s) => dir && dir.rva >= s.virtualAddress && dir.rva < s.virtualAddress + s.virtualSize,
  );
}

/**
 * The mod compiled against `image`, its pristine exe: the bytes it changes outside the
 * resources (runs of changed bytes) and the resources it replaces, whole.
 */
export function compileMod(image: PeImage, mod: Mod): ModPatch {
  checkMod(mod);
  need(sha256(image.data) === mod.base, "base", "the mod is for another exe");
  const built = parsePe(build(image, canonical(mod.changes)));
  const rsrc = resourceSection(image);
  const writes: PatchWrite[] = [];
  for (const s of image.sections) {
    if (s === rsrc) continue;
    const before = image.data.subarray(s.rawOffset, s.rawOffset + s.rawSize);
    const after = built.data.subarray(s.rawOffset, s.rawOffset + s.rawSize);
    for (let i = 0; i < before.length; i++) {
      if (before[i] === after[i]) continue;
      const start = i;
      while (i < before.length && before[i] !== after[i]) i++;
      const va = image.imageBase + s.virtualAddress + start;
      writes.push({ va, bytes: after.slice(start, i) });
    }
  }
  const pristine = readResources(image);
  const resources = readResources(built).flatMap(({ type, name, language, data }) => {
    const old = findResource(pristine, type, name, language);
    return old && sameBytes(old.data, data) ? [] : [{ type, name, language, data }];
  });
  return { base: mod.base, writes, resources };
}

/** `image` with the patch applied: the exe a mod makes (see applyMod). */
export function applyPatch(image: PeImage, patch: ModPatch): Uint8Array {
  need(sha256(image.data) === patch.base, "base", "the patch is for another exe");
  let data: Uint8Array = image.data.slice();
  for (const { va, bytes } of patch.writes) data.set(bytes, fileOffset(image, va, bytes.length));
  for (const { type, name, language, data: content } of patch.resources) {
    const current = parsePe(data);
    const resource = findResource(readResources(current), type, name, language);
    need(resource !== undefined, `resource ${String(type)}/${String(name)}`, "not in the exe");
    data = replaceResource(current, resource, content);
  }
  return data;
}

/** The exe the mod makes of `image`, its pristine exe. */
export function applyMod(image: PeImage, mod: Mod): Uint8Array {
  return applyPatch(image, compileMod(image, mod));
}

// --- the file -----------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(text: string, where: string): Uint8Array {
  need(/^[A-Za-z0-9+/]*={0,2}$/.test(text) && text.length % 4 === 0, where, "not base64");
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

function fromHex(text: string, where: string): Uint8Array {
  need(/^([0-9a-f]{2})+$/i.test(text), where, "not hex bytes");
  return Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/** The mod as its JSON file; changes in key order, so saving again gives the same file. */
export function modJson(mod: Mod): string {
  checkMod(mod);
  const {
    tileTypes,
    events,
    code,
    dealer,
    copyTexts,
    texts,
    rooms,
    start,
    rucksack,
    flags,
    backdrop,
    moves,
  } = canonical(mod.changes);
  const file: Json = {
    format: MOD_FORMAT,
    name: mod.name,
    author: mod.author,
    description: mod.description,
    base: { sha256: mod.base },
    changes: {
      tileTypes: tileTypes.map((c) => ({
        episode: c.episode,
        from: c.from,
        types: c.types.map(([to, of]) => [to, of]),
      })),
      events: events.map((c) => ({
        episode: c.episode,
        entry: c.entry,
        id: c.id,
        points: c.points,
        ...(c.sound === undefined ? {} : { sound: c.sound }),
      })),
      code: code.map((c) => ({
        va: `0x${c.va.toString(16)}`,
        expect: hex(c.expect),
        bytes: hex(c.bytes),
      })),
      dealer: dealer.map((c) => ({
        episode: c.episode,
        most: c.most,
        goods: c.goods.map(({ classId, state, price }) => [classId, state, price]),
      })),
      copyTexts: copyTexts.map((c) => ({
        resource: c.resource,
        from: c.from,
        entries: c.entries.map(([to, of]) => [to, of]),
      })),
      texts: texts.map((c) => ({
        resource: c.resource,
        entry: c.entry,
        variants: c.variants && [...c.variants],
      })),
      rooms: rooms.map((c) => ({
        episode: c.episode,
        id: c.id,
        scene: c.room && toBase64(serializeRoom(c.room)),
      })),
      start: start.map((c) => ({ episode: c.episode, room: c.room, x: c.x, y: c.y })),
      rucksack: rucksack.map((c) => ({ episode: c.episode, capacity: c.capacity })),
      flags: flags.map((c) => ({ episode: c.episode, flags: `0x${c.flags.toString(16)}` })),
      backdrop: backdrop.map((c) => ({ episode: c.episode, rule: c.rule })),
      moves: moves.map((c) => ({ episode: c.episode, diagonal: c.diagonal })),
    },
  };
  // arrays of numbers (the pairs) on one line each; strings hold no line breaks
  const json = JSON.stringify(file, null, 2).replace(
    /\[\n\s+(\d+(?:,\n\s+\d+)*)\n\s+\]/g,
    (_, list: string) => `[${list.split(/,\n\s+/).join(", ")}]`,
  );
  return `${json}\n`;
}

function object(v: unknown, where: string): Record<string, unknown> {
  need(typeof v === "object" && v !== null && !Array.isArray(v), where, "not an object");
  return v as Record<string, unknown>;
}

function array(v: unknown, where: string): unknown[] {
  need(Array.isArray(v), where, "not an array");
  return v as unknown[];
}

function string(v: unknown, where: string): string {
  need(typeof v === "string", where, "not a string");
  return v;
}

function int(v: unknown, where: string): number {
  need(typeof v === "number" && Number.isInteger(v), where, "not an integer");
  return v;
}

/** [to, of] pairs of integers. */
function pairs(v: unknown, where: string): (readonly [number, number])[] {
  return array(v, where).map((pair, i) => {
    const items = array(pair, `${where}[${i}]`);
    need(items.length === 2, `${where}[${i}]`, "not a pair");
    return [int(items[0], `${where}[${i}]`), int(items[1], `${where}[${i}]`)] as const;
  });
}

/** A mod from its JSON file (modJson); throws a ModError naming what is wrong. */
export function parseMod(text: string): Mod {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ModError(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const file = object(json, "mod");
  need(file["format"] === MOD_FORMAT, "format", `not ${MOD_FORMAT}`);
  const changes = object(file["changes"] ?? {}, "changes");
  const list = <T>(kind: string, read: (o: Record<string, unknown>, where: string) => T) =>
    array(changes[kind] ?? [], kind).map((v, i) =>
      read(object(v, `${kind}[${i}]`), `${kind}[${i}]`),
    );
  const mod: Mod = {
    name: string(file["name"] ?? "", "name"),
    author: string(file["author"] ?? "", "author"),
    description: string(file["description"] ?? "", "description"),
    base: string(object(file["base"], "base")["sha256"], "base.sha256"),
    changes: {
      tileTypes: list("tileTypes", (o, w) => ({
        episode: int(o["episode"], `${w}.episode`),
        from: int(o["from"], `${w}.from`),
        types: pairs(o["types"], `${w}.types`),
      })),
      events: list("events", (o, w) => ({
        episode: int(o["episode"], `${w}.episode`),
        entry: int(o["entry"], `${w}.entry`),
        id: int(o["id"], `${w}.id`),
        points: int(o["points"], `${w}.points`),
        ...(o["sound"] === undefined ? {} : { sound: string(o["sound"], `${w}.sound`) }),
      })),
      code: list("code", (o, w) => {
        const va = string(o["va"], `${w}.va`);
        need(/^0x[0-9a-f]+$/i.test(va), `${w}.va`, "not a hex address (0x…)");
        return {
          va: parseInt(va, 16),
          expect: fromHex(string(o["expect"], `${w}.expect`), `${w}.expect`),
          bytes: fromHex(string(o["bytes"], `${w}.bytes`), `${w}.bytes`),
        };
      }),
      dealer: list("dealer", (o, w) => ({
        episode: int(o["episode"], `${w}.episode`),
        most: int(o["most"], `${w}.most`),
        goods: array(o["goods"], `${w}.goods`).map((v, n) => {
          const where = `${w}.goods[${n}]`;
          const items = array(v, where).map((item) => int(item, where));
          need(items.length === 3, where, "not [class, state, price]");
          const [classId, state, price] = items;
          return { classId, state, price };
        }),
      })),
      copyTexts: list("copyTexts", (o, w) => ({
        resource: int(o["resource"], `${w}.resource`),
        from: int(o["from"], `${w}.from`),
        entries: pairs(o["entries"], `${w}.entries`),
      })),
      texts: list("texts", (o, w) => ({
        resource: int(o["resource"], `${w}.resource`),
        entry: int(o["entry"], `${w}.entry`),
        variants:
          o["variants"] === null
            ? null
            : array(o["variants"], `${w}.variants`).map((v) => string(v, `${w}.variants`)),
      })),
      rooms: list("rooms", (o, w) => {
        const scene = o["scene"];
        let room: Room | null = null;
        if (scene !== null) {
          const bytes = fromBase64(string(scene, `${w}.scene`), `${w}.scene`);
          try {
            room = parseRoom(bytes);
          } catch (error) {
            need(false, `${w}.scene`, error instanceof Error ? error.message : String(error));
          }
        }
        return { episode: int(o["episode"], `${w}.episode`), id: int(o["id"], `${w}.id`), room };
      }),
      start: list("start", (o, w) => ({
        episode: int(o["episode"], `${w}.episode`),
        room: int(o["room"], `${w}.room`),
        x: int(o["x"], `${w}.x`),
        y: int(o["y"], `${w}.y`),
      })),
      rucksack: list("rucksack", (o, w) => ({
        episode: int(o["episode"], `${w}.episode`),
        capacity: int(o["capacity"], `${w}.capacity`),
      })),
      flags: list("flags", (o, w) => {
        const flags = string(o["flags"], `${w}.flags`);
        need(/^0x[0-9a-f]{1,8}$/i.test(flags), `${w}.flags`, "not a hex word (0x…)");
        return { episode: int(o["episode"], `${w}.episode`), flags: parseInt(flags, 16) };
      }),
      backdrop: list("backdrop", (o, w) => ({
        episode: int(o["episode"], `${w}.episode`),
        rule: string(o["rule"], `${w}.rule`) as BackdropRule,
      })),
      moves: list("moves", (o, w) => {
        need(typeof o["diagonal"] === "boolean", `${w}.diagonal`, "not true or false");
        return { episode: int(o["episode"], `${w}.episode`), diagonal: o["diagonal"] };
      }),
    },
  };
  checkMod(mod);
  return mod;
}
