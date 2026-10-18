import { type EpisodeClasses, readEpisodeClasses } from "./classes.ts";
import { type Rgb, episodePalette } from "./palette.ts";
import { type PeImage, parsePe } from "./pe.ts";
import { type PeResource, findResource, readResources, replaceResource } from "./resources.ts";
import { cryptScene } from "./scene-crypt.ts";
import { type Room, parseScene, serializeScene } from "./scene.ts";
import { type ShapeTable, parseShapes } from "./shapes.ts";

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
export const sceneId = (episode: number) => 1004 + 100 * episode;

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
