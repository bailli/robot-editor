import {
  type Completion,
  type CompletionSource,
  autocompletion,
  snippetCompletion,
} from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { EditorState, type Extension, type Range, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  WidgetType,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";

import { ScriptError, type ScriptPiece, scanScript, scriptHandlers } from "@robot/formats";

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
  /** The game's names a script can use, for completion. */
  names(): readonly ScriptName[];
}

/** A name of the game: a function (one per argument count), a variable or a constant. */
export interface ScriptName {
  name: string;
  kind: "function" | "variable" | "constant";
  /** A function's argument names. */
  args?: readonly string[];
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
        shown.className = /^(?:O|EV)_/.test(piece.text) ? "constant" : "variable";
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
 * Completes the name before the cursor (not in comments and strings): statements, the
 * game's functions (as snippets: Tab goes to the next argument), variables and constants
 * with what they mean, and the script's own variables.
 */
export function scriptCompletions(events: ScriptViewEvents): CompletionSource {
  return (context) => {
    const word = context.matchBefore(/[A-Za-z_]\w*/);
    if (!word && !context.explicit) return null;
    const pieces = scanScript(context.state.doc.toString());
    const inside = pieces.find((p) => p.at < context.pos && context.pos <= p.at + p.text.length);
    if (inside?.kind === "comment" || inside?.kind === "string") return null;
    const info = (name: string) => () => {
      const text = events.explain(name);
      return text === undefined ? null : document.createTextNode(text);
    };
    const options: Completion[] = [...STATEMENTS].map((label) => ({ label, type: "keyword" }));
    for (const { name, kind, args } of events.names()) {
      if (kind === "function") {
        const list = args ?? [];
        const fields = list.map((a) => `\${${a}}`).join(", ");
        const detail = `(${list.join(", ")})`;
        options.push(
          snippetCompletion(`${name}(${fields})`, {
            label: name,
            detail,
            type: kind,
            info: info(name),
          }),
        );
      } else {
        options.push({ label: name, type: kind, info: info(name) });
      }
    }
    // the script's own variables (lower case), except the one being typed
    const locals = new Set(
      pieces
        .filter((p) => p.kind === "name" && /^[a-z]/.test(p.text) && p.at !== word?.from)
        .map((p) => p.text),
    );
    for (const label of locals) {
      if (!STATEMENTS.has(label))
        options.push({ label, type: "variable", detail: "of this script" });
    }
    return { from: word?.from ?? context.pos, options, validFor: /^\w*$/ };
  };
}

/** The marked-up source of an editor and, while editing, what the compiler says. */
interface Marked {
  shown: Shown[];
  /** The compiler's complaint, undefined if the source compiles (or is not checked). */
  error: string | undefined;
  decorations: DecorationSet;
}

/** A line between the source's lines: what a handler waits for, or a warning about it. */
class NoteWidget extends WidgetType {
  readonly text: string;
  readonly className: string;
  readonly title: string;

  constructor(text: string, className: string, title: string) {
    super();
    this.text = text;
    this.className = className;
    this.title = title;
  }

  override eq(other: NoteWidget): boolean {
    return (
      other.text === this.text && other.className === this.className && other.title === this.title
    );
  }

  toDOM(): HTMLElement {
    const note = document.createElement("div");
    note.className = this.className;
    note.textContent = this.text;
    note.title = this.title;
    return note;
  }
}

const HANDLER_TITLE =
  "A handler: when the script runs, its event function only registers the block and " +
  "returns 0, so the block is skipped; the game runs it when the event happens, until return.";

/**
 * The handlers of a script: a line above each saying what it waits for, a bar along its
 * lines and, when it does not end with return, a warning below it.
 */
function handlerDecorations(doc: Text): Range<Decoration>[] {
  const decorations: Range<Decoration>[] = [];
  const lineOf = (at: number) => doc.lineAt(Math.min(at, doc.length)).number;
  const lines = (list: readonly number[]) => {
    const numbers = [...new Set(list.map(lineOf))];
    const last = numbers.pop();
    return numbers.length === 0 ? `line ${last}` : `lines ${numbers.join(", ")} and ${last}`;
  };
  for (const handler of scriptHandlers(doc.toString())) {
    const first = doc.lineAt(handler.at);
    const last = doc.line(lineOf(Math.max(handler.to, handler.at)));
    const label = `▸ on ${handler.events}${handler.conditional ? ", if …" : ""}`;
    const title =
      `A handler for ${handler.events}` +
      (handler.conditional ? ", run when the rest of its condition holds as well" : "") +
      `. ${HANDLER_TITLE}`;
    decorations.push(
      Decoration.widget({
        widget: new NoteWidget(label, "script-handler-label", title),
        block: true,
        side: -1,
      }).range(first.from),
    );
    for (let n = first.number; n <= last.number; n++) {
      decorations.push(Decoration.line({ class: "script-handler" }).range(doc.line(n).from));
    }
    if (handler.runsOn === undefined) continue;
    const runsOn = lineOf(handler.runsOn);
    const again = handler.again.length > 0 ? lines(handler.again) : undefined;
    const warning = `⚠ no return: ${again ? `registers ${again} again` : `runs on into line ${runsOn}`}`;
    const explained =
      `No return: after this handler the script runs on at line ${runsOn}` +
      (again
        ? `, and each time it registers the handler in ${again} once more, which ` +
          "then runs more than once (nothing checks for doubles)"
        : "") +
      ". End the block with return; unless the code after it is meant to run as well.";
    decorations.push(
      Decoration.widget({
        widget: new NoteWidget(warning, "script-handler-warning", explained),
        block: true,
        side: 1,
      }).range(last.to),
    );
  }
  return decorations;
}

/**
 * Spans for the pieces of the source, the handlers and, where the compiler knows it, its
 * error.
 */
function decorate(shown: readonly Shown[], doc: Text, error: unknown): DecorationSet {
  const marks: Range<Decoration>[] = shown
    .filter(({ piece }) => piece.kind !== "space")
    .map(({ piece, className, title }) =>
      Decoration.mark({ class: className, attributes: title ? { title } : {} }).range(
        piece.at,
        piece.at + piece.text.length,
      ),
    );
  // the piece the error is at (at the end of the source: the last one)
  const at = error instanceof ScriptError ? error.at : undefined;
  const piece =
    at === undefined
      ? undefined
      : shown.findLast((s) => s.piece.kind !== "space" && s.piece.at <= at)?.piece;
  if (piece && error instanceof Error) {
    const mark = Decoration.mark({ class: "script-error", attributes: { title: error.message } });
    marks.push(mark.range(piece.at, piece.at + piece.text.length));
  }
  return Decoration.set([...marks, ...handlerDecorations(doc)], true);
}

/** The editor's state field: the source marked up, compiled too when `compile` is given. */
function marking(events: ScriptViewEvents, compile?: (source: string) => void) {
  const mark = (state: EditorState): Marked => {
    const source = state.doc.toString();
    const shown = markUp(source, events);
    let error: unknown;
    let message: string | undefined;
    try {
      compile?.(source);
    } catch (e) {
      error = e;
      message = e instanceof Error ? e.message : String(e);
    }
    return { shown, error: message, decorations: decorate(shown, state.doc, error) };
  };
  return StateField.define<Marked>({
    create: mark,
    update: (marked, transaction) => (transaction.docChanged ? mark(transaction.state) : marked),
    provide: (field) => EditorView.decorations.from(field, (marked) => marked.decorations),
  });
}

/** CodeMirror's own parts in the colours of the page (the pieces' are in style.css). */
const theme = EditorView.theme({
  "&": { color: "var(--text)", backgroundColor: "var(--panel)" },
  "&.cm-focused": { outline: "2px solid var(--accent)" },
  ".cm-scroller": { font: "13px/1.45 ui-monospace, monospace" },
  ".cm-content": { padding: "8px 0", caretColor: "var(--text)" },
  ".cm-cursor": { borderLeftColor: "var(--text)" },
  ".cm-gutters": {
    backgroundColor: "var(--panel)",
    color: "var(--muted)",
    borderRight: "1px solid var(--line)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 6%, transparent)" },
  ".cm-tooltip": {
    color: "var(--text)",
    backgroundColor: "var(--panel)",
    border: "1px solid var(--line)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    color: "var(--text)",
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent)",
  },
  ".cm-completionDetail": { color: "var(--muted)" },
  ".cm-completionInfo": { maxWidth: "40em", whiteSpace: "pre-line" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 25%, transparent) !important",
  },
});

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
  /** The CodeMirror view shown (read-only or the editor). */
  private code: EditorView | undefined;

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
    // the same script stays as it is shown (scrolled, the info line)
    if (same && !this.editing && source === this.source && this.code) return;
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
    this.code?.destroy();
    this.code = undefined;
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
      this.code?.focus();
    });
    const parts: HTMLElement[] = [bar];
    if (this.source) {
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent =
        "The game runs the script once when the hero enters the room; the marked blocks " +
        "(handlers, after Event(…) and E_…(…)) run when their event happens, until return.";
      parts.push(hint);
      button(
        this.showCode ? "Hide bytecode" : "Bytecode",
        "The compiled script the game runs",
        () => {
          this.showCode = !this.showCode;
          this.render();
        },
      );
      const { view, info } = this.codeView(this.source, [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ]);
      parts.push(view.dom, info);
      if (this.showCode) parts.push(this.bytecode(this.source));
    }
    this.element.replaceChildren(...parts);
  }

  /**
   * A CodeMirror view of the source, marked up, and a line saying what the mouse is over
   * (explanations can be long, e.g. all pages of a message).
   */
  private codeView(
    source: string,
    extensions: Extension[],
    compile?: (source: string) => void,
  ): { view: EditorView; info: HTMLElement; field: StateField<Marked> } {
    const field = marking(this.events, compile);
    const info = document.createElement("p");
    info.className = "script-info";
    info.textContent = "Hover a name or number to see what it means.";
    const view = new EditorView({
      doc: source,
      extensions: [
        field,
        theme,
        lineNumbers(),
        highlightSpecialChars(),
        EditorView.domEventHandlers({
          mouseover: (event, view) => {
            const target = event.target instanceof Element ? event.target : undefined;
            const titled = target?.closest("[title]");
            if (titled && view.contentDOM.contains(titled)) {
              info.textContent = titled.getAttribute("title");
            }
            // the call whose function name is under the mouse
            const name = target?.closest(".function");
            const at = name ? view.posAtDOM(name) : -1;
            const call = view.state.field(field).shown.find((s) => s.piece.at === at)?.call;
            this.events.hover(call?.fn, call?.args ?? []);
          },
          mouseleave: () => {
            this.events.hover(undefined, []);
          },
        }),
        EditorView.editorAttributes.of({ class: "script-source" }),
        ...extensions,
      ],
    });
    this.code = view;
    return { view, info, field };
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

  /** The editor, the compiler's verdict and the apply/cancel buttons. */
  private editor(button: (label: string, title: string, click: () => void) => HTMLButtonElement) {
    const verdict = document.createElement("p");
    verdict.className = "script-verdict";
    // Cancel first, the confirming action last, as in every dialog of the editor
    button("Cancel", "Leave the script as it is", () => {
      this.close();
    });
    const apply = button("Apply", "Compile and give the room this script (undoable)", () => {
      try {
        this.events.apply(this.draft);
        this.close();
      } catch (error) {
        verdict.textContent = String(error);
        verdict.classList.add("error");
      }
    });
    apply.classList.add("primary");
    let error: string | undefined;
    const check = () => {
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
    const compile = (source: string) => {
      if (source.trim() !== "") this.events.compile(source);
    };
    const { view, info, field } = this.codeView(
      this.draft,
      [
        drawSelection(),
        highlightActiveLine(),
        autocompletion({ override: [scriptCompletions(this.events)] }),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.editorAttributes.of({ class: "script-edit" }),
        EditorView.contentAttributes.of({ "aria-label": "Script source" }),
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          this.draft = update.state.doc.toString();
          error = update.state.field(field).error;
          check();
        }),
      ],
      compile,
    );
    error = view.state.field(field).error;
    this.recheck = check;
    check();
    return [view.dom, verdict, info];
  }
}
