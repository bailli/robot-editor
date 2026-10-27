/**
 * Mods: what a fan episode changes, applied to the pristine exe (STATUS, "The mod format").
 *
 * A mod is a set of keyed changes, each key at most once, applied in a fixed order of
 * kinds (a later kind wins over an earlier one):
 *   1. tileTypes  (episode, target type)  tile types from another episode (withTileTypes)
 *   2. events     (episode, entry)        an event table entry's id and points
 *   3. code       (address)               bytes written where the exe holds `expect`
 *   4. copyTexts  (resource, entry)       a text entry copied from another one of the exe
 *      texts      (resource, entry)       a text entry set or removed (withTextEntry)
 *   5. rooms      (episode, room id)      a room replaced, added or removed (withScene)
 *   6. start      (episode)               where the episode starts (withEpisodeStart)
 * copyTexts and texts share their keys: an entry is either copied or written. Copies read
 * the exe as kinds 1-3 left it, so the mod carries no text of the game's own. The event
 * tables are full: a new event takes over an entry the episode never uses.
 * Applying first compiles the mod against the pristine exe (checked by its sha256) into a
 * patch: byte writes outside the resources and whole replaced resources. The exe writer
 * (applyPatch) and, later, the proxy as an in-memory loader apply only that patch.
 *
 * The file is JSON: format, name, author, description, base { sha256 }, changes with one
 * array per kind; code as hex strings, rooms as base64 of serializeRoom (null removes).
 */
import {
  EVENT_IDS_END,
  FIRST_EVENT_ID,
  eventTableLength,
  readEventTable,
  withEventEntries,
} from "./events.ts";
import { EPISODES, Game } from "./game.ts";
import { DIRECTORY_RESOURCE, type PeImage, parsePe, readVa } from "./pe.ts";
import { findResource, readResources, replaceResource } from "./resources.ts";
import { ROOM_HEIGHT, ROOM_WIDTH, type Room, parseRoom, serializeRoom } from "./scene.ts";
import { sha256 } from "./sha256.ts";
import { type EpisodeStart, withEpisodeStart } from "./start.ts";
import { parseTexts, textEntryProblem, withTextEntry } from "./texts.ts";

export const MOD_FORMAT = 1;
/** Room ids have 10 bits (records and exits hold them so). */
const MAX_ROOM_ID = 0x3ff;
const TYPES = 128;

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
  /** From entry 128 on 0 (none) or FIRST_EVENT_ID to EVENT_IDS_END - 1, once per table. */
  id: number;
  points: number;
}

export interface CodeChange {
  va: number;
  /** What the pristine exe holds there; the change is refused otherwise. */
  expect: Uint8Array;
  bytes: Uint8Array;
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

export interface ModChanges {
  tileTypes: readonly TileTypesChange[];
  events: readonly EventChange[];
  code: readonly CodeChange[];
  copyTexts: readonly CopyTextsChange[];
  texts: readonly TextChange[];
  rooms: readonly RoomChange[];
  start: readonly StartChange[];
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
  copyTexts: [],
  texts: [],
  rooms: [],
  start: [],
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

function episodeOk(episode: number, where: string): void {
  need((EPISODES as readonly number[]).includes(episode), where, `no episode ${episode}`);
}

/** Throws a ModError naming the change if any change is invalid or a key repeats. */
export function checkMod(mod: Mod): void {
  need(/^[0-9a-f]{64}$/.test(mod.base), "base", "not a sha256 (64 lowercase hex digits)");
  const { tileTypes, events, code, copyTexts, texts, rooms, start } = mod.changes;
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
      need(isInt(to, 0, TYPES - 1) && isInt(of, 0, TYPES - 1), where, `types ${to}, ${of}`);
      once(`type ${c.episode} ${to}`, `${where} (type ${to})`);
    }
  });
  events.forEach((c, i) => {
    const where = `events[${i}] (episode ${c.episode}, entry ${c.entry})`;
    episodeOk(c.episode, where);
    need(isInt(c.entry, 0, eventTableLength(c.episode) - 1), where, "no such entry");
    const ids =
      c.entry < TYPES
        ? isInt(c.id, 0, EVENT_IDS_END - 1)
        : c.id === 0 || isInt(c.id, FIRST_EVENT_ID, EVENT_IDS_END - 1);
    need(ids, where, `id ${c.id} (from entry 128 on 0 or ${FIRST_EVENT_ID}-${EVENT_IDS_END - 1})`);
    need(isInt(c.points, -0x80000000, 0x7fffffff), where, `points ${c.points}`);
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
}

// --- applying -----------------------------------------------------------------------

/** File offset of `length` bytes at `va` (they must be initialised data). */
function offsetOf(image: PeImage, va: number, length: number): number {
  return readVa(image, va, length).byteOffset - image.data.byteOffset;
}

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
  };
}

/** The mod's changes applied through the editing functions, in the order of kinds. */
function build(image: PeImage, changes: ModChanges): Uint8Array {
  let game = new Game(image.data);
  for (const c of changes.tileTypes) {
    game = new Game(game.withTileTypes(c.episode, c.from, new Map(c.types)));
  }
  for (const episode of new Set(changes.events.map((c) => c.episode))) {
    const entries = changes.events.filter((c) => c.episode === episode);
    game = new Game(
      withEventEntries(game.image, episode, new Map(entries.map((c) => [c.entry, c]))),
    );
    // an id maps to one entry (the constructor's last one would win)
    const seen = new Map<number, number>();
    readEventTable(game.image, episode).forEach(({ id }, n) => {
      if (n < TYPES || id === 0) return;
      const other = seen.get(id);
      need(
        other === undefined,
        `events (episode ${episode})`,
        `entries ${other} and ${n} both have id ${id}`,
      );
      seen.set(id, n);
    });
  }
  if (changes.code.length > 0) {
    const out = game.image.data.slice();
    changes.code.forEach((c, i) => {
      const where = `code[${i}] at 0x${c.va.toString(16)}`;
      let at = 0;
      try {
        at = offsetOf(game.image, c.va, c.bytes.length);
      } catch {
        need(false, where, "no initialised data there");
      }
      const found = out.subarray(at, at + c.bytes.length);
      need(hex(found) === hex(c.expect), where, `the exe holds ${hex(found)}`);
      out.set(c.bytes, at);
    });
    game = new Game(out);
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
    game = new Game(game.withText(resource, withTextChanges(text, set)));
  }
  for (const episode of new Set(changes.rooms.map((c) => c.episode))) {
    const set = changes.rooms.filter((r) => r.episode === episode);
    game = new Game(game.withScene(episode, withRoomChanges(game.episode(episode).rooms, set)));
  }
  let data = game.image.data;
  for (const { episode, ...start } of changes.start) {
    data = withEpisodeStart(parsePe(data), episode, start);
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
  return { writes, resources };
}

/** `image` with the patch applied: the exe a mod makes (see applyMod). */
export function applyPatch(image: PeImage, patch: ModPatch): Uint8Array {
  let data: Uint8Array = image.data.slice();
  for (const { va, bytes } of patch.writes) data.set(bytes, offsetOf(image, va, bytes.length));
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
  const { tileTypes, events, code, copyTexts, texts, rooms, start } = canonical(mod.changes);
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
      })),
      code: code.map((c) => ({
        va: `0x${c.va.toString(16)}`,
        expect: hex(c.expect),
        bytes: hex(c.bytes),
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
    },
  };
  checkMod(mod);
  return mod;
}
