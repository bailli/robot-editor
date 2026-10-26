/**
 * The room settings kept in tags (see scene.ts) besides the exits byte (exits.ts) and the
 * script (script.ts): the darkness, the points for the first visit, the background music
 * and episode III's flags. A setting of 0 (no music: "") has no tag, as the loader reads a
 * missing tag as 0; the original scenes keep their tags sorted by kind.
 */
import { encodeCp437 } from "./cp437.ts";
import { MUSIC_NAME_LENGTH, musicName } from "./music.ts";
import type { Room, RoomTag } from "./scene.ts";
import { SCRIPT_TAG, ScriptPart } from "./script.ts";

export const DARKNESS_TAG = 2;
export const FLAGS_TAG = 3;
export const POINTS_TAG = 4;
export const MUSIC_TAG = 5;

/** Night on entering goes from 0 (light) to 100; the originals use 40-100. */
export const MAX_DARKNESS = 100;
/** The points tag holds points / 10 in 12 bits. */
export const POINTS_STEP = 10;
export const MAX_VISIT_POINTS = 0xfff * POINTS_STEP;

/** Episode III flags (kind 3; the other episodes ignore them). */
export const RoomFlag = {
  /** Room 144: entering from room 146 builds the labyrinth anew (0x40ca30). */
  LABYRINTH: 1,
  /** Message 944 after 15 s in the room, once per game, unless herbs were eaten (0x40ca70). */
  DIZZY: 2,
} as const;
/** Kind 3 is a byte. */
const MAX_FLAGS = 0xff;

export interface RoomSettings {
  /** Night on entering, 0-100 (GetNight, SetNight). */
  darkness: number;
  /** Points for the first visit, a multiple of 10. */
  points: number;
  /** A piece of the episode's MUSIC resource, "" for none (silence). */
  music: string;
  /** Episode III flags (RoomFlag). */
  flags: number;
}

function tag(room: Room, kind: number): RoomTag | undefined {
  return room.tags.find((t) => t.kind === kind);
}

export function roomSettings(room: Room): RoomSettings {
  const music = tag(room, MUSIC_TAG)?.data;
  return {
    // kinds 1-3 are bytes for the game (scene.ts)
    darkness: (tag(room, DARKNESS_TAG)?.value ?? 0) & 0xff,
    points: (tag(room, POINTS_TAG)?.value ?? 0) * POINTS_STEP,
    music: music ? musicName(music) : "",
    flags: (tag(room, FLAGS_TAG)?.value ?? 0) & 0xff,
  };
}

/**
 * When the original editor saved the room (tag 6/3, a Unix time; not read by the game),
 * undefined for rooms without one.
 */
export function roomSaveTime(room: Room): Date | undefined {
  const data = room.tags.find((t) => t.kind === SCRIPT_TAG && t.value === ScriptPart.TIME)?.data;
  if (data?.length !== 4) return undefined;
  return new Date(new DataView(data.buffer, data.byteOffset).getUint32(0, true) * 1000);
}

/** `room.tags` with the tag of `kind` replaced, added in kind order or (undefined) removed. */
function withTag(tags: readonly RoomTag[], kind: number, value: RoomTag | undefined): RoomTag[] {
  const at = tags.findIndex((t) => t.kind === kind);
  const rest = tags.filter((t) => t.kind !== kind);
  if (!value) return rest;
  const later = rest.findIndex((t) => t.kind > kind);
  rest.splice(at >= 0 ? at : later < 0 ? rest.length : later, 0, value);
  return rest;
}

const check = (ok: boolean, message: string) => {
  if (!ok) throw new RangeError(message);
};

/**
 * A copy of `room` with the given settings changed. Throws a RangeError for values the
 * tags cannot hold (music names: 8 CP437 characters).
 */
export function withRoomSettings(room: Room, settings: Partial<RoomSettings>): Room {
  let tags = [...room.tags];
  const { darkness, points, music, flags } = settings;
  if (darkness !== undefined) {
    check(
      Number.isInteger(darkness) && darkness >= 0 && darkness <= MAX_DARKNESS,
      `the darkness goes from 0 to ${MAX_DARKNESS}`,
    );
    tags = withTag(
      tags,
      DARKNESS_TAG,
      darkness ? { kind: DARKNESS_TAG, value: darkness } : undefined,
    );
  }
  if (points !== undefined) {
    check(
      Number.isInteger(points) &&
        points >= 0 &&
        points <= MAX_VISIT_POINTS &&
        points % POINTS_STEP === 0,
      `points for the first visit are a multiple of ${POINTS_STEP} up to ${MAX_VISIT_POINTS}`,
    );
    const value = points / POINTS_STEP;
    tags = withTag(tags, POINTS_TAG, value ? { kind: POINTS_TAG, value } : undefined);
  }
  if (music !== undefined) {
    const bytes = encodeCp437(music);
    check(
      bytes.length <= MUSIC_NAME_LENGTH && !bytes.includes(0),
      `music names have at most ${MUSIC_NAME_LENGTH} characters`,
    );
    const data = new Uint8Array(MUSIC_NAME_LENGTH);
    data.set(bytes);
    const old = tag(room, MUSIC_TAG);
    tags = withTag(
      tags,
      MUSIC_TAG,
      music ? { kind: MUSIC_TAG, value: old?.value ?? 0, data } : undefined,
    );
  }
  if (flags !== undefined) {
    check(Number.isInteger(flags) && flags >= 0 && flags <= MAX_FLAGS, "the flags are a byte");
    tags = withTag(tags, FLAGS_TAG, flags ? { kind: FLAGS_TAG, value: flags } : undefined);
  }
  return { ...room, tags };
}
