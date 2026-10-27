import {
  type EpisodeClasses,
  readClassTable,
  readEpisodeClasses,
  withClassEntries,
} from "./classes.ts";
import { decodeCp437, encodeCp437 } from "./cp437.ts";
import { crunch, uncrunch } from "./crunched.ts";
import { EVENT_TEXT, readEventTable, withEventEntries } from "./events.ts";
import { musicPieces } from "./music.ts";
import { type Rgb, episodePalette } from "./palette.ts";
import { type PeImage, parsePe } from "./pe.ts";
import { type PeResource, findResource, readResources, replaceResource } from "./resources.ts";
import { type RoomName, roomName } from "./room-names.ts";
import { cryptScene } from "./scene-crypt.ts";
import { type Room, parseScene, serializeScene } from "./scene.ts";
import { type ScriptKeyword, readScriptKeywords, scriptConstants } from "./script.ts";
import { type ShapeTable, parseShapes, withShapes } from "./shapes.ts";
import { type Texts, parseObjectNames, parseTexts, withTextEntry } from "./texts.ts";

export const EPISODES = [0, 1, 2, 3, 4] as const;
export const EPISODE_NAMES = ["Robot Junior", "Robot I", "Robot II", "Robot III", "Robot IV"];

/** The room each episode starts in (measured in the unpatched game). */
export const START_ROOMS: Readonly<Partial<Record<number, number>>> = {
  0: 43,
  1: 43,
  2: 43,
  3: 41,
  4: 53,
};

/** Resource ids of episode n (0 = Junior): shapes 1002, scene 1004, plus 100 n. */
export const shapesId = (episode: number) => 1002 + 100 * episode;
/** The robots' sprites (`_Aliens`, 8 per episode, 5 in episode IV) and more. */
export const actorShapesId = (episode: number) => 1001 + 100 * episode;
export const sceneId = (episode: number) => 1004 + 100 * episode;
export const musicId = (episode: number) => 1005 + 100 * episode;
export const soundsId = (episode: number) => 1006 + 100 * episode;
/** German texts; English (1011, 1111) exists for Junior and episode I only. */
export const textsId = (episode: number, language: Language = "de") =>
  (language === "de" ? 1010 : 1011) + 100 * episode;

/** Room names: the episode's texts, except episode III's own resource 1320 (vtable +0x44). */
export const roomNamesId = (episode: number, language: Language = "de") =>
  episode === 3 ? 1320 + (language === "de" ? 0 : 1) : textsId(episode, language);

/**
 * Texts of first takes and events (1800 + n, see events.ts): as room names, episode III
 * keeps them in its own resource 1320 (vtable +0x38, 0x40b310).
 */
export const eventTextsId = roomNamesId;

export type Language = "de" | "en";

export interface Episode {
  number: number;
  /** The _Rob_object shape table, indexed by map tile type. */
  objects: ShapeTable;
  rooms: Room[];
  classes: EpisodeClasses;
  palette: Rgb[];
}

/** GameOfRobot.exe with lazily loaded episodes. */
export class Game {
  readonly image: PeImage;
  readonly resources: PeResource[];
  private readonly episodes = new Map<number, Episode>();
  private readonly parsedTexts = new Map<number, Texts | undefined>();
  private readonly constants = new Map<number, ReadonlyMap<string, number>>();
  private keywords: readonly ScriptKeyword[] | undefined;

  constructor(data: Uint8Array) {
    this.image = parsePe(data);
    this.resources = readResources(this.image);
  }

  resource(type: string | number, name: string | number): PeResource {
    const found = findResource(this.resources, type, name);
    if (!found) throw new Error(`resource ${String(type)}/${String(name)} not found`);
    return found;
  }

  episode(number: number): Episode {
    let episode = this.episodes.get(number);
    if (!episode) {
      const objects = parseShapes(this.resource("SHAPES", shapesId(number)).data).get(
        "_Rob_object",
      );
      if (!objects) throw new Error(`episode ${number}: no _Rob_object shapes`);
      episode = {
        number,
        objects,
        rooms: parseScene(cryptScene(this.resource("SCENE", sceneId(number)).data)),
        classes: readEpisodeClasses(this.image, number),
        palette: episodePalette(this.image, number),
      };
      this.episodes.set(number, episode);
    }
    return episode;
  }

  /** The sprites robots are drawn with (`_Aliens`); each robot takes one, in turn. */
  aliens(episode: number): ShapeTable {
    return parseShapes(this.resource("SHAPES", actorShapesId(episode)).data).get("_Aliens") ?? [];
  }

  /** The episode's tile descriptions and messages (see texts.ts), if it has them. */
  episodeTexts(episode: number, language: Language = "de"): Texts | undefined {
    return this.texts(textsId(episode, language));
  }

  /**
   * The name the game shows for a room (see room-names.ts), undefined where it shows
   * "Szene <id>". `rooms` defaults to the episode's own (edits can change the name's room).
   */
  roomName(
    episode: number,
    id: number,
    rooms: readonly Room[] = this.episode(episode).rooms,
    language: Language = "de",
  ): RoomName | undefined {
    const texts = this.texts(roomNamesId(episode, language));
    return roomName(texts, episode, id, rooms, this.episode(episode).classes);
  }

  /** A text resource's entries (see texts.ts), undefined if missing. */
  texts(id: number): Texts | undefined {
    if (!this.parsedTexts.has(id)) {
      const source = this.textSource(id);
      this.parsedTexts.set(id, source === undefined ? undefined : parseTexts(source));
    }
    return this.parsedTexts.get(id);
  }

  /** A text resource as the game unpacks it (see texts.ts), undefined if missing. */
  textSource(id: number): string | undefined {
    const resource = findResource(this.resources, "CRUNCHED", id);
    return resource && this.decode(resource.data);
  }

  /**
   * A copy of the exe whose text resource `id` holds `text` (compressed with crunch; it
   * moves to the end of the resources if it grows, see replaceResource). Throws a
   * RangeError for characters outside code page 437.
   */
  withText(id: number, text: string): Uint8Array {
    return replaceResource(
      this.image,
      this.resource("CRUNCHED", id),
      crunch(encodeCp437(text.replace(/\n*$/, "\n"))),
    );
  }

  /** The pieces of the episode's MUSIC resource (songs and sound effects). */
  musicPieces(episode: number): string[] {
    return musicPieces(this.resource("MUSIC", musicId(episode)).data);
  }

  /** Script names of the episode's objects by tile type, e.g. 21 -> "KEY". */
  objectNames(episode: number): Map<number, string> {
    return parseObjectNames(this.decode(this.resource("CRUNCHED", soundsId(episode)).data));
  }

  /** The names room scripts can use: the game's functions and variables. */
  scriptKeywords(): readonly ScriptKeyword[] {
    this.keywords ??= readScriptKeywords(this.image);
    return this.keywords;
  }

  /** The episode's script constants ("O_KEY" -> tile type, see scriptConstants). */
  scriptConstants(episode: number): ReadonlyMap<string, number> {
    let constants = this.constants.get(episode);
    if (!constants) {
      constants = scriptConstants(this.objectNames(episode), this.episode(episode).classes);
      this.constants.set(episode, constants);
    }
    return constants;
  }

  private decode(data: Uint8Array): string {
    return decodeCp437(uncrunch(data).text);
  }

  room(episode: number, id: number): Room {
    const room = this.episode(episode).rooms.find((r) => r.id === id);
    if (!room) throw new Error(`episode ${episode} has no room ${id}`);
    return room;
  }

  /**
   * A copy of the exe whose scene for `episode` holds `rooms`. The original scenes fill
   * their resources exactly, so most edits grow the resource (see replaceResource).
   */
  withScene(episode: number, rooms: readonly Room[]): Uint8Array {
    return replaceResource(
      this.image,
      this.resource("SCENE", sceneId(episode)),
      cryptScene(serializeScene(rooms)),
    );
  }

  /**
   * A copy of the exe in which tile types of `episode` become those of episode `from`
   * (`types`: target type -> source type), as far as the data goes: the class table
   * entry, the _Rob_object shape, the description (text entry n), the line of the sound
   * table (its sound only where `episode` has that piece, else the target's stays) and
   * the first take (event table entry n and its text 1800 + n, eventTextsId). Other texts a class
   * shows (messages, hints) and code that checks the episode are the caller's.
   */
  withTileTypes(episode: number, from: number, types: ReadonlyMap<number, number>): Uint8Array {
    const source = this.episode(from);
    const table = readClassTable(this.image, from);
    const events = readEventTable(this.image, from);
    const sourceTexts = this.episodeTexts(from)?.entries;
    const sourceEventTexts = this.texts(eventTextsId(from))?.entries;
    const sourceSounds = this.decode(this.resource("CRUNCHED", soundsId(from)).data);
    const pieces = new Set(this.musicPieces(episode));
    const pairs = [...types];
    let game = new Game(
      withClassEntries(this.image, episode, new Map(pairs.map(([to, of]) => [to, table[of]]))),
    );
    game = new Game(
      withEventEntries(game.image, episode, new Map(pairs.map(([to, of]) => [to, events[of]]))),
    );
    const shapes = game.resource("SHAPES", shapesId(episode));
    const objects = new Map(pairs.map(([to, of]) => [to, source.objects[of] ?? null]));
    game = new Game(
      replaceResource(game.image, shapes, withShapes(shapes.data, "_Rob_object", objects)),
    );
    let text = game.textSource(textsId(episode)) ?? "";
    for (const [to, of] of pairs) text = withTextEntry(text, to, sourceTexts?.get(of));
    game = new Game(game.withText(textsId(episode), text));
    text = game.textSource(eventTextsId(episode)) ?? "";
    for (const [to, of] of pairs) {
      text = withTextEntry(text, EVENT_TEXT + to, sourceEventTexts?.get(EVENT_TEXT + of));
    }
    game = new Game(game.withText(eventTextsId(episode), text));
    let sounds = game.textSource(soundsId(episode)) ?? "";
    for (const [to, of] of pairs) {
      const [, sound, note] = soundLine(sourceSounds, of);
      const [found, own] = soundLine(sounds, to);
      const kept = pieces.has(sound.replace(/^!/, "")) ? sound : own;
      const line = `${to}:${kept}${note ? ` ;${note}` : ""}`;
      // the game reads the lines by number (0x4389b0), in any order
      sounds = found
        ? sounds.replace(new RegExp(`^${to}:.*$`, "m"), line)
        : `${sounds.trimEnd()}\n${line}\n`;
    }
    return game.withText(soundsId(episode), sounds);
  }
}

/** Line n of a sound table: [line, sound, note] (empty where missing). */
function soundLine(text: string, n: number): [string, string, string] {
  const match = new RegExp(String.raw`^${n}:[ \t]*([^;\s]*)[^;\n]*(?:;[ \t]*(.*))?$`, "m").exec(
    text,
  );
  return [match?.[0] ?? "", match?.[1] ?? "", match?.[2]?.trim() ?? ""];
}
