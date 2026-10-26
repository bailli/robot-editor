/**
 * A script's handlers, read from its source: an event function (Event, E_Take, …) in the
 * condition of an `if` registers the statement it guards (see script-docs). Plain C to
 * read, so the editor shows them: what each waits for, and whether it ends with `return`
 * or runs on into the code after it, registering the handlers there once more (0x407b30
 * does not check for doubles). Works on any source, also one that does not compile.
 */
import { SCRIPT_EVENTS, type ScriptPiece, scanScript } from "./script.ts";

const EVENT_FUNCTIONS = new Set(["EVENT", "E_TAKE", "E_DROP", "E_AREA", "E_SLOT", "E_NEWROOM"]);

/** The events of Event's mask by bit, as the editor names them. */
const EVENT_NAMES = ["take", "drop", "walk area", "entering the room", "slot"];

export interface ScriptHandler {
  /** Where its `if` is. */
  at: number;
  /** Where the event function's name is. */
  call: number;
  /** What it waits for, e.g. "take · drop · entering the room". */
  events: string;
  /** Whether the condition tests more than the event (`Event(4) && E_Value == 1`). */
  conditional: boolean;
  /** The statement it guards, from its first character to after its last. */
  from: number;
  to: number;
  /** Whether every way through it ends with `return`. */
  returns: boolean;
  /** Where the script goes on after it when it does not return; undefined: nothing follows. */
  runsOn: number | undefined;
  /** The event functions the script then reaches (where their names are). */
  again: number[];
}

/** A statement as token indices: [from, to). */
interface Statement {
  kind: "block" | "if" | "for" | "return" | "expression";
  from: number;
  to: number;
  /** Block: its statements; if: then and else; for: the body. */
  children: Statement[];
  /** If and for: the tokens between the parentheses. */
  condition: [number, number];
}

/** The statements of a script; tolerant: whatever it cannot read ends at the next ";". */
function parse(code: readonly ScriptPiece[]): Statement[] {
  let t = 0;
  const text = (i: number) => code[i]?.text;
  const statement = (): Statement => {
    const from = t;
    const word = text(t);
    if (word === "else") {
      // without its if (while editing)
      t++;
      return statement();
    }
    if (word === "{") {
      t++;
      const children: Statement[] = [];
      while (t < code.length && text(t) !== "}") children.push(statement());
      if (t < code.length) t++;
      return { kind: "block", from, to: t, children, condition: [t, t] };
    }
    if (word === "if" || word === "for") {
      t++;
      const open = t;
      let close = t;
      if (text(t) === "(") {
        for (let depth = 0; t < code.length; t++) {
          if (text(t) === "(") depth++;
          else if (text(t) === ")" && --depth === 0) break;
        }
        close = t;
        if (t < code.length) t++;
      }
      const children = [statement()];
      if (word === "if" && text(t) === "else") {
        t++;
        children.push(statement());
      }
      return { kind: word, from, to: t, children, condition: [open + 1, close] };
    }
    // an expression or return, up to its ";" (or the "}" of the block it is in)
    for (let depth = 0; t < code.length; t++) {
      const x = text(t);
      if (x === "(") depth++;
      else if (x === ")") depth--;
      else if (depth <= 0 && x === "}") break;
      else if (depth <= 0 && x === ";") {
        t++;
        break;
      }
    }
    const kind = word === "return" ? "return" : "expression";
    return { kind, from, to: t, children: [], condition: [t, t] };
  };
  const statements: Statement[] = [];
  while (t < code.length) {
    if (text(t) === "}") t++;
    else statements.push(statement());
  }
  return statements;
}

/** Whether every way through a statement ends with `return`. */
function returns(s: Statement): boolean {
  if (s.kind === "return") return true;
  if (s.kind === "block") return s.children.some(returns);
  return s.kind === "if" && s.children.length === 2 && s.children.every(returns);
}

/** The value of an event mask of numbers and EV_ names with + and |, if it is one. */
function eventMask(code: readonly ScriptPiece[], from: number, to: number): number | undefined {
  let t = from;
  const atom = (): number | undefined => {
    const piece = code[t++] as ScriptPiece | undefined;
    if (piece?.kind === "number") return Number(piece.text);
    if (piece?.kind === "name") return SCRIPT_EVENTS.get(piece.text);
    if (piece?.text !== "(") return undefined;
    const value = or();
    return code[t++]?.text === ")" ? value : undefined;
  };
  const sum = () => {
    let value = atom();
    while (value !== undefined && code[t]?.text === "+") {
      t++;
      const next = atom();
      value = next === undefined ? undefined : value + next;
    }
    return value;
  };
  const or = (): number | undefined => {
    let value = sum();
    while (value !== undefined && code[t]?.text === "|") {
      t++;
      const next = sum();
      value = next === undefined ? undefined : value | next;
    }
    return value;
  };
  const value = or();
  return t === to ? value : undefined;
}

/** The token after the ")" that closes the "(" at `open`. */
function afterParens(code: readonly ScriptPiece[], open: number): number {
  for (let t = open, depth = 0; t < code.length; t++) {
    if (code[t].text === "(") depth++;
    else if (code[t].text === ")" && --depth === 0) return t + 1;
  }
  return code.length;
}

/** The event functions called in tokens [from, to). */
function eventCalls(code: readonly ScriptPiece[], from: number, to: number): number[] {
  const calls: number[] = [];
  for (let t = from; t < to; t++) {
    const piece = code[t];
    if (piece.kind === "name" && code[t + 1]?.text === "(") {
      if (EVENT_FUNCTIONS.has(piece.text.toUpperCase())) calls.push(t);
    }
  }
  return calls;
}

/** The script's handlers in source order. */
export function scriptHandlers(source: string): ScriptHandler[] {
  const code = scanScript(source).filter((p) => p.kind !== "space" && p.kind !== "comment");
  const handlers: ScriptHandler[] = [];
  // where token t starts (the end of the source after the last), where token t − 1 ends
  const start = (t: number) => (t < code.length ? code[t].at : source.length);
  const end = (t: number) => code[t - 1].at + code[t - 1].text.length;
  const handlerCall = (s: Statement) =>
    s.kind === "if" ? eventCalls(code, ...s.condition).at(0) : undefined;

  // the event functions running a statement reaches: not those in the handlers it skips
  const reached = (s: Statement): number[] => {
    if (s.kind === "return" || s.kind === "expression") return eventCalls(code, s.from, s.to);
    const own = s.kind === "block" ? [] : eventCalls(code, ...s.condition);
    const children = handlerCall(s) === undefined ? s.children : s.children.slice(1);
    return [...own, ...children.flatMap(reached)];
  };

  const describe = (call: number): string => {
    const name = code[call].text;
    const to = afterParens(code, call + 1);
    const closed = code[to - 1].text === ")";
    const args = source.slice(end(call + 2), closed ? start(to - 1) : source.length).trim();
    switch (name.toUpperCase()) {
      case "EVENT": {
        const mask = eventMask(code, call + 2, to - 1);
        if (mask === undefined || mask === 0) return `Event(${args})`;
        const names = [];
        for (let bit = 0; 1 << bit <= mask; bit++) {
          if (mask & (1 << bit)) names.push(EVENT_NAMES[bit] ?? `event ${1 << bit}`);
        }
        return names.join(" · ");
      }
      case "E_TAKE":
        return `taking ${args}`;
      case "E_DROP":
        return `dropping ${args}`;
      case "E_AREA":
        return `walk area ${args}`;
      case "E_SLOT":
        return `slot ${args}`;
      default:
        return `entering room ${args}`;
    }
  };

  // the condition without parentheses around it and an assignment of the call's value
  const tested = (from: number, to: number): [number, number] => {
    for (;;) {
      if (code[from]?.text === "(" && afterParens(code, from) === to) {
        from++;
        to--;
      } else if (code[from]?.kind === "name" && code[from + 1]?.text === "=") {
        from += 2;
      } else {
        return [from, to];
      }
    }
  };

  const empty = (s: Statement) =>
    s.to === s.from || (s.to === s.from + 1 && code[s.from].text === ";");

  /** Walks statements; `after` is what runs after the last of them. */
  const walk = (statements: readonly Statement[], after: readonly Statement[]) => {
    statements.forEach((s, i) => {
      const next = [...statements.slice(i + 1), ...after].filter((n) => !empty(n));
      // a statement that always returns ends the script
      const stop = next.findIndex(returns);
      const then = stop < 0 ? next : next.slice(0, stop + 1);
      const call = handlerCall(s);
      if (call !== undefined) {
        const body = s.children[0];
        const done = returns(body) || then.length === 0 || then[0].kind === "return";
        const [from, to] = tested(...s.condition);
        handlers.push({
          at: start(s.from),
          call: start(call),
          events: describe(call),
          conditional: from !== call || to !== afterParens(code, call + 1),
          from: start(body.from),
          to: body.to > body.from ? end(body.to) : start(body.from),
          returns: returns(body),
          runsOn: done ? undefined : start(then[0].from),
          again: done ? [] : then.flatMap(reached).map(start),
        });
      }
      if (s.kind === "block") walk(s.children, next);
      else if (s.kind === "if") for (const child of s.children) walk([child], next);
      else if (s.kind === "for") walk(s.children, [s, ...next]);
    });
  };
  walk(parse(code), []);
  return handlers.sort((a, b) => a.at - b.at);
}
