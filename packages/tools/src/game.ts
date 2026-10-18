import { readFileSync } from "node:fs";

import {
  type EpisodeClasses,
  type PeImage,
  type PeResource,
  type Rgb,
  type Room,
  type ShapeTable,
  cryptScene,
  episodePalette,
  findResource,
  parsePe,
  parseScene,
  parseShapes,
  readEpisodeClasses,
  readResources,
} from "@robot/formats";

/** Repository root (game data and generated files are relative to it). */
export const ROOT = new URL("../../../", import.meta.url);
export const DEFAULT_EXE = new URL("reference/GameOfRobot.exe", ROOT);
export const EPISODES = [0, 1, 2, 3, 4] as const;

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

  static load(path: URL | string = DEFAULT_EXE): Game {
    return new Game(new Uint8Array(readFileSync(path)));
  }

  resource(type: string | number, name: string | number): PeResource {
    const found = findResource(this.resources, type, name);
    if (!found) throw new Error(`resource ${String(type)}/${String(name)} not found`);
    return found;
  }

  episode(number: number): Episode {
    let episode = this.episodes.get(number);
    if (!episode) {
      const objects = parseShapes(this.resource("SHAPES", 1002 + 100 * number).data).get(
        "_Rob_object",
      );
      if (!objects) throw new Error(`episode ${number}: no _Rob_object shapes`);
      episode = {
        number,
        objects,
        rooms: parseScene(cryptScene(this.resource("SCENE", 1004 + 100 * number).data)),
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
}
