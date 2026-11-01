import { EPISODES, MAX_MUSIC_PIECES } from "@robot/formats";

import { button, element, select } from "./dom.ts";
import type { MusicCopy } from "./editor.ts";
import { patchChildren } from "./patch.ts";

export interface MusicViewEvents {
  /** Copies piece `piece` of episode `from` into the episode's music (Editor.copyMusic). */
  copy(from: number, piece: string): void;
  /** Takes a copied piece out of the episode's music (Editor.removeMusic). */
  remove(piece: string): void;
}

/** What the view shows: the shown episode's pieces copied from other episodes. */
export interface MusicContext {
  episode: number;
  names: readonly string[];
  copies: readonly MusicCopy[];
  /** How many pieces the episode's music has. */
  count: number;
  /** The pieces of an episode that can be copied (Editor.sourceMusic). */
  sources: (episode: number) => readonly string[];
  /** Pieces some room of the game plays (offered first: these are songs). */
  roomMusic: ReadonlySet<string>;
}

/** The episodes in the form and the list, short. */
const SHORT_NAMES: readonly string[] = ["Junior", "I", "II", "III", "IV"];
const short = (episode: number) => SHORT_NAMES[episode] ?? String(episode);

/**
 * The Episode tab's music from other episodes (mod kind music): the pieces copied along
 * with events, tile types and kits whose sounds the episode lacks or by themselves, each
 * with what plays it and removable, and a form to copy a piece of another episode.
 * Patched in place (patchChildren); the form's choices stay while the episode does.
 */
export class MusicView {
  readonly element = element("section", "start-view record-view tile-types-view");
  private readonly events: MusicViewEvents;
  private context: MusicContext | undefined;
  /** The form's choices: source episode and piece. */
  private choice: { episode: number; from: number; piece: string } | undefined;

  /** Forgets the choices (a newly loaded exe or mod). */
  reset(): void {
    this.choice = undefined;
  }

  constructor(events: MusicViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Music");
  }

  show(context: MusicContext): void {
    this.context = context;
    patchChildren(this.element, this.render(context));
  }

  private render(context: MusicContext): Node[] {
    const { episode, names, copies } = context;
    const name = (e: number) => names[e] ?? `episode ${e}`;
    const nodes: Node[] = [element("h3", undefined, "Music from other episodes")];
    if (copies.length === 0) {
      const none = element("p", "hint", `${name(episode)} has no music of other episodes.`);
      none.dataset["key"] = "none";
      nodes.push(none);
    } else {
      const list = element("ul", "dealer-goods");
      list.dataset["key"] = `pieces ${episode}`;
      for (const c of copies) {
        const row = element("li", "dealer-good");
        row.dataset["key"] = c.piece;
        const uses = [...(c.kept ? ["by itself"] : []), ...c.uses];
        const text = element(
          "span",
          "dealer-name",
          `${c.piece} ← ${short(c.from)}${uses.length > 0 ? `: ${uses.join(", ")}` : ""}`,
        );
        text.title = `${c.piece} of ${name(c.from)}, with its instruments, after this episode’s own pieces`;
        // read when clicked: a kept button keeps its listener (patchChildren)
        const remove = button("×", `Take ${c.piece} out (its events lose their sound)`, () => {
          this.events.remove(row.dataset["key"] ?? "");
        });
        remove.classList.add("danger");
        remove.setAttribute("aria-label", `Remove ${c.piece}`);
        row.append(text, remove);
        list.append(row);
      }
      nodes.push(list);
    }
    nodes.push(...this.form(context));
    nodes.push(
      element(
        "p",
        "hint",
        "Sounds and room music are pieces of the episode’s music. Copied events, tile types and kits bring the pieces their sounds need where this episode lacks them; one goes by itself once nothing plays it. A piece copied here stays (rooms can play it, tab Room). × takes one out now: its events lose their sound, copied tile types keep this episode’s own; a piece a room plays stays.",
      ),
    );
    return nodes;
  }

  /** The form: source episode and piece, and the button. */
  private form(context: MusicContext): Node[] {
    const { episode } = context;
    const others = EPISODES.filter((e) => e !== episode);
    let choice = this.choice;
    if (choice?.episode !== episode) choice = { episode, from: others[0] ?? 0, piece: "" };
    // the songs first, as the Room tab offers them
    const listed = context.sources(choice.from);
    const sources = [
      ...listed.filter((p) => context.roomMusic.has(p)),
      ...listed.filter((p) => !context.roomMusic.has(p)),
    ];
    if (!sources.includes(choice.piece)) choice.piece = sources[0] ?? "";
    this.choice = choice;
    const from = select(
      "From episode",
      others.map((e) => [String(e), short(e)]),
      String(choice.from),
    );
    const piece = select(
      "Piece",
      sources.map((p) => [p, context.roomMusic.has(p) ? `${p} (room music)` : p]),
      choice.piece,
    );
    const changed = (edit: (now: NonNullable<typeof this.choice>) => void) => () => {
      const now = this.choice;
      const shown = this.context;
      if (!now || !shown) return;
      edit(now);
      this.show(shown);
    };
    from.addEventListener(
      "change",
      changed((now) => {
        now.from = Number(from.value);
        now.piece = "";
      }),
    );
    piece.addEventListener(
      "change",
      changed((now) => {
        now.piece = piece.value;
      }),
    );
    const add = button("Copy", "Copy the piece into this episode’s music, to stay", () => {
      const now = this.choice;
      if (now && now.piece !== "") this.events.copy(now.from, now.piece);
    });
    const full = context.count >= MAX_MUSIC_PIECES;
    add.disabled = full || sources.length === 0;
    if (full) add.title = `The episode has ${MAX_MUSIC_PIECES} pieces, the most a sound can name`;
    else if (sources.length === 0)
      add.title = `This episode has all pieces of ${short(choice.from)}`;
    const rows: [string, Node[]][] = [
      ["from", [element("span", "record-label", "From"), from]],
      ["piece", [element("span", "record-label", "Piece"), piece]],
    ];
    const form = rows.map(([key, children]) => {
      const row = element("label", "record-row");
      row.dataset["key"] = key;
      row.append(...children);
      return row;
    });
    const bar = element("div", "start-bar");
    bar.dataset["key"] = "add";
    bar.append(add, element("span", "hint", `${context.count} of ${MAX_MUSIC_PIECES} pieces`));
    return [...form, bar];
  }
}
