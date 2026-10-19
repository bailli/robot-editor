import { type EpisodeClasses, readEpisodeClasses } from "./classes.ts";
import { decodeCp437 } from "./cp437.ts";
import { uncrunch } from "./crunched.ts";
import { type Rgb, episodePalette } from "./palette.ts";
import { type PeImage, parsePe } from "./pe.ts";
import { type PeResource, findResource, readResources, replaceResource } from "./resources.ts";
import { type RoomName, roomName } from "./room-names.ts";
import { cryptScene } from "./scene-crypt.ts";
import { type Room, parseScene, serializeScene } from "./scene.ts";
import { type ShapeTable, parseShapes } from "./shapes.ts";
import { type Texts, parseObjectNames, parseTexts } from "./texts.ts";

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
export const soundsId = (episode: number) => 1006 + 100 * episode;
/** German texts; English (1011, 1111) exists for Junior and episode I only. */
export const textsId = (episode: number, language: Language = "de") =>
  (language === "de" ? 1010 : 1011) + 100 * episode;

/** Room names: the episode's texts, except episode III's own resource 1320 (vtable +0x44). */
export const roomNamesId = (episode: number, language: Language = "de") =>
  episode === 3 ? 1320 + (language === "de" ? 0 : 1) : textsId(episode, language);

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
  private readonly texts = new Map<number, Texts | undefined>();

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
    return this.textResource(textsId(episode, language));
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
    const texts = this.textResource(roomNamesId(episode, language));
    return roomName(texts, episode, id, rooms, this.episode(episode).classes);
  }

  private textResource(id: number): Texts | undefined {
    if (!this.texts.has(id)) {
      const resource = findResource(this.resources, "CRUNCHED", id);
      this.texts.set(id, resource && parseTexts(this.decode(resource.data)));
    }
    return this.texts.get(id);
  }

  /** Script names of the episode's objects by tile type, e.g. 21 -> "KEY". */
  objectNames(episode: number): Map<number, string> {
    return parseObjectNames(this.decode(this.resource("CRUNCHED", soundsId(episode)).data));
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
}
