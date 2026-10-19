import { type Game, LOGIC_CELL, displayText } from "@robot/formats";

export interface TileInfo {
  /** The object's script name (O_KEY -> "Key"), for the tiles that have one. */
  name: string | undefined;
  /** What the game says when the hero looks at the tile (variants, often by state). */
  descriptions: string[];
}

const hex = (value: number) => `0x${value.toString(16).padStart(4, "0")}`;

/** Names and descriptions of an episode's tiles, from its texts. */
export class TileNames {
  private readonly names: Map<number, string>;
  private readonly texts: Map<number, string[]>;

  constructor(game: Game, episode: number) {
    this.names = game.objectNames(episode);
    this.texts = game.episodeTexts(episode)?.entries ?? new Map<number, string[]>();
  }

  info(value: number): TileInfo {
    const type = value & 0xff;
    if (type === LOGIC_CELL) {
      return { name: "Logic cell", descriptions: ["Drawn and run by the room's logic record."] };
    }
    const name = this.names.get(type);
    return {
      name: name && name.charAt(0) + name.slice(1).toLowerCase(),
      descriptions: (this.texts.get(type) ?? []).map(displayText).filter((d) => d !== ""),
    };
  }

  /** A tooltip: value, name and every description. */
  title(value: number): string {
    const { name, descriptions } = this.info(value);
    return [[hex(value), name].filter(Boolean).join(" "), ...descriptions].join("\n");
  }

  /** One line: name, else the first description. */
  summary(value: number): string {
    const { name, descriptions } = this.info(value);
    const text = descriptions.at(0) ?? "";
    return name ? `${name}${text ? ` – ${text}` : ""}` : text;
  }
}
