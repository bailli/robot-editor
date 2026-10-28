import type { CodePatch } from "./editor.ts";
import { patchChildren } from "./patch.ts";

export interface CodeViewEvents {
  /** Writes `bytes` at `va` as a code change of the mod (Editor.addCode). */
  add(va: number, bytes: Uint8Array): void;
  /** Takes the mod's code change at `va` out (Editor.removeCode). */
  remove(va: number): void;
}

/** What the view shows: the mod's code changes and what the form needs. */
export interface CodeContext {
  patches: readonly CodePatch[];
  /** The bytes the exe holds where a patch would go (Editor.codeBytes). */
  read(va: number, length: number): Uint8Array | undefined;
  /** Why the bytes cannot go there (Editor.codeProblem). */
  problem(va: number, bytes: Uint8Array): string | undefined;
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

/** An address typed in hex ("0x40b466" or "40b466"), undefined if it is none. */
export function parseAddress(text: string): number | undefined {
  const digits = text.trim().replace(/^0x/i, "");
  return /^[0-9a-f]{1,8}$/i.test(digits) ? parseInt(digits, 16) : undefined;
}

/** Bytes typed in hex, spaces between them or not ("90 90", "9090"), undefined if none. */
export function parseBytes(text: string): Uint8Array | undefined {
  const digits = text.replace(/\s+/g, "");
  if (!/^([0-9a-f]{2})+$/i.test(digits)) return undefined;
  return Uint8Array.from(digits.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/**
 * The Episode tab's code patches (mod kind code, for all episodes), folded while the mod
 * has none: each change with its address, section, the bytes the exe holds there and
 * those written, a warning where edits made here write over it, and a button that takes
 * it out; a form that writes bytes at an address (what the exe holds there now shows
 * while typing). Patched in place (patchChildren), so the form keeps what is typed.
 */
export class CodeView {
  readonly element = element("section", "start-view record-view tile-types-view");
  private readonly details = element("details", "code-view");
  private readonly summary = element("summary");
  private readonly list = element("ul", "dealer-goods code-patches");
  private readonly address = element("input", "record-field");
  private readonly bytes = element("input", "record-field");
  private readonly now = element("p", "hint code-now");
  private readonly add = element("button", undefined, "Patch");
  private readonly events: CodeViewEvents;
  private context: CodeContext | undefined;
  /** Patches when last shown: the section opens when the first one comes. */
  private count = 0;

  constructor(events: CodeViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Code patches");
    this.address.setAttribute("aria-label", "Address");
    this.address.placeholder = "0x40b466";
    this.address.spellcheck = false;
    this.bytes.setAttribute("aria-label", "Bytes");
    this.bytes.placeholder = "90 90";
    this.bytes.spellcheck = false;
    this.add.type = "button";
    this.add.title = "Write the bytes at the address (a code change of the mod)";
    for (const input of [this.address, this.bytes]) {
      input.addEventListener("input", () => {
        this.check();
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") this.submit();
      });
    }
    this.add.addEventListener("click", () => {
      this.submit();
    });
    // built once, so what is typed and the focus stay; only the list is patched
    const rows = (
      [
        ["Address", this.address],
        ["Bytes", this.bytes],
      ] as const
    ).map(([label, input]) => {
      const row = element("label", "record-row");
      row.append(element("span", "record-label", label), input);
      return row;
    });
    const bar = element("div", "start-bar");
    bar.append(this.now, this.add);
    const hint = element(
      "p",
      "hint",
      "Bytes the mod writes into the exe’s code or data, for all episodes; a mod opens only where the exe holds what each patch expects. Wrong bytes crash the game. The start, rucksack, flags, backdrop rule, moves and dealer are no patches (they have their own settings above) and win where they write the same bytes.",
    );
    const body = element("div", "code-body");
    body.append(this.list, ...rows, bar, hint);
    this.details.append(this.summary, body);
    this.element.append(this.details);
  }

  show(context: CodeContext): void {
    this.context = context;
    const { patches } = context;
    if (patches.length > 0 && this.count === 0) this.details.open = true;
    this.count = patches.length;
    this.summary.textContent =
      patches.length > 0 ? `Code patches (${patches.length})` : "Code patches";
    this.list.hidden = patches.length === 0;
    patchChildren(this.list, this.render(patches));
    this.check();
  }

  private render(patches: readonly CodePatch[]): Node[] {
    return patches.map((p) => {
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
      return row;
    });
  }

  /** The form's address and bytes, and why they cannot be written (else undefined). */
  private typed(): { va: number; bytes: Uint8Array; problem?: string } | undefined {
    const va = parseAddress(this.address.value);
    const bytes = parseBytes(this.bytes.value);
    if (va === undefined || !bytes) return undefined;
    const problem = this.context?.problem(va, bytes);
    return problem ? { va, bytes, problem } : { va, bytes };
  }

  /** Shows what the exe holds at the typed address, or why the bytes cannot go there. */
  private check(): void {
    const va = parseAddress(this.address.value);
    const typed = this.typed();
    const length = typed?.bytes.length ?? 1;
    const held = va === undefined ? undefined : this.context?.read(va, length);
    let text = "Address and bytes in hex";
    if (va !== undefined) {
      text = held ? `The exe holds ${hex(held, 8)}` : `No code or data at ${address(va)}`;
    }
    if (this.bytes.value.trim() && !parseBytes(this.bytes.value)) text = "Bytes: hex pairs";
    if (typed?.problem) text = `Cannot patch: ${typed.problem}`;
    this.now.textContent = text;
    this.now.classList.toggle("code-problem", typed?.problem !== undefined);
    this.add.disabled = !typed || typed.problem !== undefined;
  }

  private submit(): void {
    const typed = this.typed();
    if (!typed || typed.problem) return;
    this.events.add(typed.va, typed.bytes);
  }
}
