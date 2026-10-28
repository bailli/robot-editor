import type { CodePatch } from "./editor.ts";
import { patchChildren } from "./patch.ts";

export interface CodeViewEvents {
  /** Takes the mod's code change at `va` out (Editor.removeCode). */
  remove(va: number): void;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const address = (va: number) => `0x${va.toString(16)}`;

/** Bytes as hex, the first `most` of them ("…" after). */
function hex(bytes: Uint8Array, most = Infinity): string {
  const shown = [...bytes.subarray(0, most)].map((b) => b.toString(16).padStart(2, "0"));
  return `${shown.join(" ")}${bytes.length > most ? " …" : ""}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The Episode tab's code patches (mod kind code, for all episodes): each change of the
 * opened mod with its address, section, the bytes the exe holds there and those written,
 * a warning where edits made here write over it, and a button that takes it out. They
 * come from a mod file only. Patched in place (patchChildren).
 */
export class CodeView {
  readonly element = element("section", "start-view record-view tile-types-view");
  private readonly events: CodeViewEvents;

  constructor(events: CodeViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Code patches");
  }

  show(patches: readonly CodePatch[]): void {
    patchChildren(this.element, this.render(patches));
  }

  private render(patches: readonly CodePatch[]): Node[] {
    const nodes: Node[] = [element("h3", undefined, "Code patches")];
    if (patches.length === 0) {
      const none = element("p", "hint", "The mod patches no code.");
      none.dataset["key"] = "none";
      nodes.push(none);
    }
    const list = element("ul", "dealer-goods code-patches");
    list.dataset["key"] = "patches";
    for (const p of patches) {
      const row = element("li", "dealer-good");
      row.dataset["key"] = String(p.va);
      const where = p.section ? ` (${p.section})` : "";
      const text = element(
        "span",
        "dealer-name",
        `${address(p.va)}${where}: ${hex(p.expect, 6)} → ${hex(p.bytes, 6)}`,
      );
      text.title = `${plural(p.bytes.length, "byte")} at ${address(p.va)}${where}\nthe exe: ${hex(p.expect)}\nthe mod: ${hex(p.bytes)}`;
      // read when clicked: a kept button keeps its listener (patchChildren)
      const remove = element("button", "danger", "×");
      remove.type = "button";
      remove.title = `The exe's own bytes at ${address(p.va)} again`;
      remove.addEventListener("click", () => {
        this.events.remove(Number(row.dataset["key"]));
      });
      row.append(text, remove);
      if (p.overwritten > 0) {
        const warning = element(
          "span",
          "code-overwritten",
          `${plural(p.overwritten, "byte")} of ${p.bytes.length} written over by edits here (start, flags, …)`,
        );
        row.append(warning);
      }
      list.append(row);
    }
    if (patches.length > 0) nodes.push(list);
    nodes.push(
      element(
        "p",
        "hint",
        "Bytes a mod writes into the exe’s code or data, for all episodes, where the exe holds what the mod expects (else it does not open). They come from a mod file; edits here that write the same bytes (the start, the rucksack, flags, the backdrop rule, moves, the dealer) win.",
      ),
    );
    return nodes;
  }
}
