import { type ScriptPiece, scanScript } from "@robot/formats";

export interface ScriptViewEvents {
  /** What a name means (function, game variable, constant), undefined if unknown. */
  explain(name: string): string | undefined;
  /**
   * What argument `index` (0 = first) of a call to `fn` refers to; `args` are the call's
   * arguments where they are plain numbers (the one asked about always is).
   */
  argument(fn: string, index: number, args: readonly (number | undefined)[]): string | undefined;
  /** Compiles a source; the disassembly, or throws a ScriptError. */
  compile(source: string): string;
  /** Gives the room this source (one undo step); throws a ScriptError. */
  apply(source: string): void;
  /**
   * The mouse is over a call of `fn` (undefined: no call) whose arguments are these
   * numbers (undefined where an argument is not a plain number).
   */
  hover(fn: string | undefined, args: readonly (number | undefined)[]): void;
}

/** A call in the source: the function and its arguments where they are plain numbers. */
export interface ScriptCall {
  fn: string;
  args: (number | undefined)[];
}

const STATEMENTS = new Set(["if", "else", "for", "return"]);

/** A piece of source as a span, with a class for its kind and an explanation as tooltip. */
interface Shown {
  piece: ScriptPiece;
  className: string;
  title?: string;
  /** For function names: the call. */
  call?: ScriptCall;
}

/** The arguments of the call whose "(" is code[open], as numbers where they are one. */
function callArguments(code: readonly ScriptPiece[], open: number): (number | undefined)[] {
  const args: ScriptPiece[][] = [[]];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const text = code[i].text;
    if (text === "(" && depth++ === 0) continue;
    if (text === ")" && --depth === 0) break;
    if (text === "," && depth === 1) args.push([]);
    else args.at(-1)?.push(code[i]);
  }
  if (args.length === 1 && args[0].length === 0) return [];
  return args.map((tokens) => {
    const [a, b] = tokens;
    if (tokens.length === 1 && a.kind === "number") return Number(a.text);
    if (tokens.length === 2 && a.text === "-" && b.kind === "number") return -Number(b.text);
    return undefined;
  });
}

/**
 * Marks up a script: names by kind (statement, function, local variable, game variable or
 * constant) with what they mean, and numbers that are a whole argument of a call with
 * what they refer to (a message's text, a room's name, …).
 */
export function markUp(source: string, events: ScriptViewEvents): Shown[] {
  const pieces = scanScript(source);
  const code = pieces.filter((p) => p.kind !== "space" && p.kind !== "comment");
  const index = new Map(code.map((p, i) => [p, i]));
  const text = (i: number) => code[i]?.text;
  // one frame per open parenthesis: the function it calls ("" for grouping) and argument
  const frames: { fn: string; arg: number; open: number }[] = [];
  return pieces.map((piece) => {
    const shown: Shown = { piece, className: piece.kind };
    const i = index.get(piece) ?? -1;
    if (piece.kind === "name") {
      if (STATEMENTS.has(piece.text)) {
        shown.className = "statement";
      } else if (text(i + 1) === "(") {
        shown.className = "function";
        shown.title = events.explain(piece.text) ?? "unknown function";
        shown.call = { fn: piece.text, args: callArguments(code, i + 1) };
      } else if (/^[A-Z]/.test(piece.text)) {
        shown.className = piece.text.startsWith("O_") ? "constant" : "variable";
        shown.title = events.explain(piece.text) ?? "unknown name";
      } else {
        shown.className = "local";
        shown.title = "a variable of this script (0 when the room is loaded)";
      }
    } else if (piece.text === "(") {
      const before = i > 0 ? code[i - 1] : undefined;
      const fn = before?.kind === "name" && !STATEMENTS.has(before.text) ? before.text : "";
      frames.push({ fn, arg: 0, open: i });
    } else if (piece.text === ")") {
      frames.pop();
    } else if (piece.text === ",") {
      const frame = frames.at(-1);
      if (frame) frame.arg++;
    } else if (piece.kind === "number") {
      const frame = frames.at(-1);
      const negative = text(i - 1) === "-";
      const start = negative ? i - 1 : i;
      const whole =
        (text(start - 1) === "(" || text(start - 1) === ",") &&
        (text(i + 1) === ")" || text(i + 1) === ",");
      if (frame?.fn && whole) {
        const title = events.argument(frame.fn, frame.arg, callArguments(code, frame.open));
        if (title) shown.title = title;
      }
    }
    return shown;
  });
}

/**
 * The room's script: the source marked up (names and numbers explain themselves on
 * hover), the compiled code on request, and an editor that compiles while typing.
 */
export class ScriptView {
  readonly element = document.createElement("section");
  private readonly events: ScriptViewEvents;
  private source = "";
  private room = "";
  private editing = false;
  private showCode = false;
  private draft = "";
  /** The source the draft started from, and how to check the draft again. */
  private draftBase = "";
  private recheck: (() => void) | undefined;

  constructor(events: ScriptViewEvents) {
    this.events = events;
    this.element.className = "script-view";
    this.element.setAttribute("aria-label", "Script");
  }

  /**
   * Shows the script of `room` (any key naming it). A draft being edited stays when the
   * same room is shown again (e.g. after another edit), and is dropped for another room.
   */
  show(source: string, room: string): void {
    const same = room === this.room;
    this.source = source;
    this.room = room;
    if (same && this.editing) {
      // the room's script may have changed underneath (undo, redo): judge the draft again
      this.recheck?.();
      return;
    }
    this.editing = false;
    this.render();
  }

  /** Leaves the editor, dropping the draft. */
  close(): void {
    this.editing = false;
    this.recheck = undefined;
    this.render();
  }

  private render(): void {
    const heading = document.createElement("h3");
    heading.textContent = this.source || this.editing ? "Script" : "No script";
    const bar = document.createElement("div");
    bar.className = "script-bar";
    bar.append(heading);
    const button = (label: string, title: string, click: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", click);
      bar.append(b);
      return b;
    };
    if (this.editing) {
      this.element.replaceChildren(bar, ...this.editor(button));
      return;
    }
    button(this.source ? "Edit" : "Add script", "Edit the script's source", () => {
      this.editing = true;
      this.draft = this.source;
      this.draftBase = this.source;
      this.render();
      this.element.querySelector("textarea")?.focus();
    });
    const parts: HTMLElement[] = [bar];
    if (this.source) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent =
        "The game runs the script once when the hero enters the room; the blocks after " +
        "Event(…) and E_…(…) run when their event happens, until return.";
      parts.push(hint);
      button(
        this.showCode ? "Hide bytecode" : "Bytecode",
        "The compiled script the game runs",
        () => {
          this.showCode = !this.showCode;
          this.render();
        },
      );
      parts.push(...this.marked(this.source));
      if (this.showCode) parts.push(this.bytecode(this.source));
    }
    this.element.replaceChildren(...parts);
  }

  /** The marked-up source and a line saying what the mouse is over. */
  private marked(source: string): HTMLElement[] {
    const pre = document.createElement("pre");
    pre.className = "script-source";
    const info = document.createElement("p");
    info.className = "script-info";
    info.textContent = "Hover a name or number to see what it means.";
    const calls = new Map<Element, ScriptCall>();
    for (const { piece, className, title, call } of markUp(source, this.events)) {
      if (piece.kind === "space") {
        pre.append(piece.text);
        continue;
      }
      const span = document.createElement("span");
      span.className = className;
      span.textContent = piece.text;
      if (title) span.title = title;
      if (call) calls.set(span, call);
      pre.append(span);
    }
    pre.addEventListener("mouseover", (event) => {
      const span = event.target instanceof HTMLElement ? event.target : undefined;
      if (span?.title) info.textContent = span.title;
      const call = span && calls.get(span);
      this.events.hover(call?.fn, call?.args ?? []);
    });
    pre.addEventListener("mouseleave", () => {
      this.events.hover(undefined, []);
    });
    return [pre, info];
  }

  private bytecode(source: string): HTMLElement {
    const pre = document.createElement("pre");
    pre.className = "script-code";
    try {
      pre.textContent = this.events.compile(source);
    } catch (error) {
      pre.textContent = String(error);
    }
    return pre;
  }

  /** The textarea, the compiler's verdict and the apply/cancel buttons. */
  private editor(button: (label: string, title: string, click: () => void) => HTMLButtonElement) {
    const area = document.createElement("textarea");
    area.className = "script-edit";
    area.spellcheck = false;
    area.value = this.draft;
    area.rows = Math.min(30, Math.max(8, this.draft.split("\n").length + 2));
    const verdict = document.createElement("p");
    verdict.className = "script-verdict";
    const apply = button("Apply", "Compile and give the room this script (undoable)", () => {
      try {
        this.events.apply(this.draft);
        this.close();
      } catch (error) {
        verdict.textContent = String(error);
        verdict.classList.add("error");
      }
    });
    button("Cancel", "Leave the script as it is", () => {
      this.close();
    });
    const check = () => {
      this.draft = area.value;
      let error: string | undefined;
      try {
        if (this.draft.trim() !== "") this.events.compile(this.draft);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      verdict.classList.toggle("error", error !== undefined);
      const changed =
        this.source === this.draftBase
          ? ""
          : " The room's script changed since editing began (undo, redo); Apply replaces it.";
      verdict.textContent =
        (error ??
          (this.draft.trim() === "" ? "Empty: the room will have no script." : "Compiles.")) +
        changed;
      apply.disabled = error !== undefined || this.draft === this.source;
    };
    area.addEventListener("input", check);
    this.recheck = check;
    check();
    return [area, verdict];
  }
}
