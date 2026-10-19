import {
  ACTOR_CLASS_NAMES,
  type EpisodeClasses,
  type Game,
  type Room,
  describeCell,
  descriptionTexts,
  displayText,
  requiredPoints,
  textPieces,
} from "@robot/formats";

export interface TileInfo {
  /** The object's script name (O_KEY -> "Key"), for the tiles that have one. */
  name: string | undefined;
  /**
   * What the game says when the hero looks at the cell: one text, or the texts it picks
   * one of at random; tiles in them as [name].
   */
  descriptions: string[];
  /** The same with the game's tile codes (`@14`), for drawing them (textPieces). */
  texts: string[];
  random: boolean;
}

const hex = (value: number) => `0x${value.toString(16).padStart(4, "0")}`;

/** Names and descriptions of an episode's cells, as the game picks them. */
export class TileNames {
  private readonly names: Map<number, string>;
  private readonly actorNames: ReadonlyMap<number, string>;
  private readonly texts: ReadonlyMap<number, readonly string[]>;
  private readonly classes: EpisodeClasses;
  private readonly episode: number;

  constructor(game: Game, episode: number) {
    // actors whose tiles have no script name: the dealer, the thief
    this.actorNames = new Map(
      [...game.episode(episode).classes.classes].flatMap(([type, c]) => {
        const name = c.id === undefined ? undefined : ACTOR_CLASS_NAMES[c.id];
        return name ? [[type, name] as const] : [];
      }),
    );
    this.names = game.objectNames(episode);
    this.texts = game.episodeTexts(episode)?.entries ?? new Map<number, string[]>();
    this.classes = game.episode(episode).classes;
    this.episode = episode;
  }

  /** `room` describes logic cells by their records. */
  info(value: number, room?: Room): TileInfo {
    const object = this.names.get(value & 0xff);
    const name = object
      ? object.charAt(0) + object.slice(1).toLowerCase()
      : this.actorNames.get(value & 0xff);
    const description = describeCell(value, this.classes, this.episode, room);
    const raw = description ? descriptionTexts(description, this.texts) : [];
    const points = requiredPoints(value, this.classes);
    const needs = points === undefined ? [] : [`Needs at least ${points} points to cross.`];
    const texts = [...needs, ...raw.map((t) => displayText(t)).filter((d) => d !== "")];
    return {
      name,
      descriptions: texts.map((t) => displayText(t, (v) => this.tileName(v))),
      texts,
      random: description !== undefined && typeof description.variant !== "number",
    };
  }

  /** A tooltip: value, name and the descriptions. */
  title(value: number, room?: Room): string {
    const { name, descriptions, random } = this.info(value, room);
    const head = [hex(value), name, random && descriptions.length > 1 ? "(one of)" : undefined];
    return [head.filter(Boolean).join(" "), ...descriptions].join("\n");
  }

  /** One line: name and the first description. */
  summary(value: number, room?: Room): string {
    const { name, descriptions } = this.info(value, room);
    const text = descriptions.at(0) ?? "";
    return name ? `${name}${text ? ` – ${text}` : ""}` : text;
  }

  /** The summary with the tiles it mentions drawn (`tile` makes the picture of one). */
  summaryNodes(value: number, room: Room | undefined, tile: (value: number) => Node): Node[] {
    const { name, texts } = this.info(value, room);
    const text = texts.at(0) ?? "";
    const nodes: Node[] = [];
    if (name) nodes.push(document.createTextNode(text ? `${name} – ` : name));
    for (const piece of textPieces(text)) {
      if (piece.kind === "text") nodes.push(document.createTextNode(piece.text));
      else {
        const picture = tile(piece.value);
        if (picture instanceof HTMLElement) {
          picture.classList.add("text-tile");
          picture.title = this.title(piece.value);
        }
        nodes.push(picture);
      }
    }
    return nodes;
  }

  /** A short name for a tile mentioned in a text: its object name, else its value. */
  tileName(value: number): string {
    const object = this.names.get(value & 0xff);
    if (object) return object.charAt(0) + object.slice(1).toLowerCase();
    return this.actorNames.get(value & 0xff) ?? hex(value);
  }
}
