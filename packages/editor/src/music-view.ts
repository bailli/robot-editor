import { button, element } from "./dom.ts";
import type { MusicCopy } from "./editor.ts";
import { patchChildren } from "./patch.ts";

export interface MusicViewEvents {
  /** Takes a copied piece out of the episode's music (Editor.removeMusic). */
  remove(piece: string): void;
}

/** What the view shows: the shown episode's pieces copied from other episodes. */
export interface MusicContext {
  episode: number;
  names: readonly string[];
  copies: readonly MusicCopy[];
}

/** The episodes in the list, short. */
const SHORT_NAMES: readonly string[] = ["Junior", "I", "II", "III", "IV"];
const short = (episode: number) => SHORT_NAMES[episode] ?? String(episode);

/**
 * The Episode tab's music from other episodes (mod kind music): the pieces copied along
 * with events, tile types and kits whose sounds the episode lacks, each with what plays
 * it and removable. Patched in place (patchChildren).
 */
export class MusicView {
  readonly element = element("section", "start-view record-view tile-types-view");
  private readonly events: MusicViewEvents;

  constructor(events: MusicViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Music");
  }

  show(context: MusicContext): void {
    patchChildren(this.element, this.render(context));
  }

  private render({ episode, names, copies }: MusicContext): Node[] {
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
        const uses = c.uses.length > 0 ? `: ${c.uses.join(", ")}` : "";
        const text = element("span", "dealer-name", `${c.piece} ← ${short(c.from)}${uses}`);
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
    nodes.push(
      element(
        "p",
        "hint",
        "Sounds and room music are pieces of the episode’s music. Copied events, tile types and kits bring the pieces their sounds need where this episode lacks them; one goes by itself once nothing plays it. × takes one out now: its events lose their sound, copied tile types keep this episode’s own; a piece a room plays stays.",
      ),
    );
    return nodes;
  }
}
