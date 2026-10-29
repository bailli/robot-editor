/**
 * Room scripts: the compiled form the game runs (room tag 6/2) and a compiler for the
 * C-like source (tag 6/1, text for people: the game runs the compiled code, verified
 * under Wine). Every room, with or without a script, has a tag 6/3 holding a Unix time
 * (1993-2008), probably when the room was last saved in the original editor; the game
 * does not read it.
 *
 * Compiled script: one byte code stream that starts with its symbol table. The loader
 * (0x406da0) links the table in place, the interpreter (0x4080e0) runs the code after it,
 * the runner (0x407fa4) starts it at offset 0 for the room's events.
 *
 * Instruction byte b:
 *   b & 0xc0 == 0x80: an operator, no operand (OPERATORS). Binary operators take the
 *     value below the top, unary ones the top, the result replaces it.
 *   otherwise: bits 4-5 give the size of a signed operand that follows (0: none, value 0;
 *     1, 2 or 4 bytes), b & 0xcf is the operation (Op).
 * Values live on a ring of 30 entries (0x4c6030); conditional jumps and stores leave
 * the top where it is, so statements leave their values behind. Function arguments are
 * moved to a separate stack (Op.ARG) and dropped after the call (Op.DROP).
 *
 * Symbol table (Op.SYMBOLS, operand = count): 14-byte entries, a name of up to 12
 * characters (zero padded), the kind (1 variable, 2 string variable, 3 function) and the
 * number of arguments. Linking (0x1e becomes 0x1f) resolves names that start with an
 * upper-case letter against the game's keywords (0x4750d8, case-insensitive, functions
 * by name and argument count); the others are the script's own variables, kept in the
 * entry and 0 when the scene is loaded.
 */
import type { EpisodeClasses } from "./classes.ts";
import { decodeCp437, encodeCp437 } from "./cp437.ts";
import { type PeImage, readVa } from "./pe.ts";
import type { Room, RoomTag } from "./scene.ts";

/** Room tag kind 6: script source (value 1), compiled script (2), a time (3). */
export const SCRIPT_TAG = 6;
export const ScriptPart = { SOURCE: 1, COMPILED: 2, TIME: 3 } as const;

/** A room's compiled script (tag 6/2), if it has one. */
export function roomCompiledScript(room: Room): Uint8Array | undefined {
  return room.tags.find((t) => t.kind === SCRIPT_TAG && t.value === ScriptPart.COMPILED)?.data;
}

const isScriptPart = (tag: RoomTag) =>
  tag.kind === SCRIPT_TAG && (tag.value === ScriptPart.SOURCE || tag.value === ScriptPart.COMPILED);

/**
 * A copy of `room` running `source`: the source (zero-terminated, like the originals)
 * and its compiled form replace the room's script tags, before tag 6/3 as in the game's
 * scenes. An empty source removes the script.
 */
export function withRoomScript(room: Room, source: string, options: CompileOptions = {}): Room {
  const tags = room.tags.filter((t) => !isScriptPart(t));
  if (source.trim() !== "") {
    const compiled = compileScript(source, options);
    const at = tags.findIndex((t) => t.kind === SCRIPT_TAG);
    tags.splice(
      at < 0 ? tags.length : at,
      0,
      ...[
        { kind: SCRIPT_TAG, value: ScriptPart.SOURCE, data: encodeCp437(`${source}\0`) },
        { kind: SCRIPT_TAG, value: ScriptPart.COMPILED, data: compiled },
      ],
    );
  }
  return { ...room, tags };
}

export const Op = {
  PUSH: 0x01,
  /** Operand = length; the string follows. */
  STRING: 0x02,
  LOAD: 0x03,
  /** Stores the top in a variable; the top stays. */
  STORE: 0x04,
  /** Moves the top to the argument stack. */
  ARG: 0x05,
  /** Drops `operand` arguments. */
  DROP: 0x06,
  /** Calls a function with the arguments on the argument stack; pushes its result. */
  CALL: 0x07,
  END: 0x08,
  /** Top = character `top` of the string below it. */
  INDEX: 0x09,
  /** The symbol table, before linking (operand = entries). */
  SYMBOLS: 0x0e,
  LINKED_SYMBOLS: 0x0f,
  /** Jumps: operand relative to the next instruction. */
  JUMP: 0x41,
  JUMP_IF_TRUE: 0x42,
  JUMP_IF_FALSE: 0x43,
} as const;

/** Operator bytes (0x4080e0) by their C spelling; "neg" is unary minus. */
export const OPERATORS: Readonly<Record<string, number>> = {
  "&": 0x80,
  "|": 0x81,
  "^": 0x82,
  "~": 0x83,
  "<<": 0x84,
  ">>": 0x85,
  "+": 0x86,
  "-": 0x87,
  "*": 0x88,
  "/": 0x89,
  "%": 0x8a,
  neg: 0x8b,
  "!": 0x8c,
  "&&": 0x8d,
  "||": 0x8e,
  "<": 0x91,
  "<=": 0x92,
  "==": 0x93,
  ">=": 0x94,
  ">": 0x95,
  "!=": 0x96,
};

const OPERATOR_NAMES = new Map(Object.entries(OPERATORS).map(([name, op]) => [op, name]));
const OP_NAMES = new Map<number, string>(
  Object.entries(Op).map(([name, op]) => [op, name.toLowerCase().replaceAll("_", " ")]),
);

export const SymbolKind = { VARIABLE: 1, STRING: 2, FUNCTION: 3 } as const;

export interface ScriptSymbol {
  name: string;
  kind: number;
  args: number;
}

export interface Instruction {
  offset: number;
  /** Op value, or the operator byte. */
  op: number;
  operand: number;
  /** Op.STRING's text. */
  text?: string;
}

export interface CompiledScript {
  symbols: ScriptSymbol[];
  code: Instruction[];
}

export class ScriptError extends Error {
  override name = "ScriptError";
  /** Offset in the source the error is at (syntax errors; not unknown names). */
  readonly at: number | undefined;

  constructor(message: string, at?: number) {
    super(message);
    this.at = at;
  }
}

const SYMBOL_SIZE = 14;
const NAME_SIZE = 12;
const OPERAND_SIZES = [0, 1, 2, 4] as const;

export const isOperator = (op: number) => (op & 0xc0) === 0x80;

export function parseCompiledScript(data: Uint8Array): CompiledScript {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const symbols: ScriptSymbol[] = [];
  const code: Instruction[] = [];
  let pc = 0;
  while (pc < data.length) {
    const offset = pc;
    const b = data[pc++];
    if (isOperator(b)) {
      if (!OPERATOR_NAMES.has(b))
        throw new ScriptError(`unknown operator 0x${b.toString(16)} at ${offset}`);
      code.push({ offset, op: b, operand: 0 });
      continue;
    }
    const size = OPERAND_SIZES[(b >> 4) & 3];
    if (pc + size > data.length) throw new ScriptError(`operand beyond the end at ${offset}`);
    const operand =
      size === 0
        ? 0
        : size === 1
          ? view.getInt8(pc)
          : size === 2
            ? view.getInt16(pc, true)
            : view.getInt32(pc, true);
    pc += size;
    const op = b & 0xcf;
    if (!OP_NAMES.has(op))
      throw new ScriptError(`unknown operation 0x${b.toString(16)} at ${offset}`);
    const instruction: Instruction = { offset, op, operand };
    if (op === Op.SYMBOLS || op === Op.LINKED_SYMBOLS) {
      for (let i = 0; i < operand; i++, pc += SYMBOL_SIZE) {
        if (pc + SYMBOL_SIZE > data.length) throw new ScriptError("symbol table beyond the end");
        const entry = data.subarray(pc, pc + SYMBOL_SIZE);
        const name = decodeCp437(entry.subarray(0, NAME_SIZE)).replace(/\0.*$/s, "");
        symbols.push({ name, kind: entry[NAME_SIZE], args: entry[NAME_SIZE + 1] });
      }
    } else if (op === Op.STRING) {
      instruction.text = decodeCp437(data.subarray(pc, pc + operand));
      pc += operand;
    }
    code.push(instruction);
  }
  return { symbols, code };
}

/** One line per instruction: offset, operation, operand (symbol names, jump targets). */
export function disassemble(script: CompiledScript): string {
  const next = (i: number) => script.code[i + 1]?.offset ?? Infinity;
  return script.code
    .map((ins, i) => {
      const name = OPERATOR_NAMES.get(ins.op) ?? OP_NAMES.get(ins.op) ?? "?";
      let operand = "";
      if (ins.op === Op.SYMBOLS || ins.op === Op.LINKED_SYMBOLS)
        operand = script.symbols.map((s) => `${s.name}/${s.kind}/${s.args}`).join(" ");
      else if (ins.op === Op.LOAD || ins.op === Op.STORE || ins.op === Op.CALL)
        operand = script.symbols[ins.operand]?.name ?? `?${ins.operand}`;
      else if (!isOperator(ins.op) && ins.op >= Op.JUMP) operand = String(next(i) + ins.operand);
      else if (ins.op === Op.STRING) operand = JSON.stringify(ins.text);
      else if (!isOperator(ins.op) && ins.operand !== 0) operand = String(ins.operand);
      return `${String(ins.offset).padStart(4)}  ${name}${operand ? ` ${operand}` : ""}`;
    })
    .join("\n");
}

/** A name the game's scripts can use (functions and the game's variables). */
export interface ScriptKeyword {
  name: string;
  /** 0x40: function; 0x80 + n: variable of n = 1 s8, 2 s16, 3 s32, 4 u8, 5 u16. */
  flags: number;
  /** The function, or the variable's address. */
  address: number;
  args: number;
}

export const KEYWORD_FUNCTION = 0x40;
export const KEYWORD_VARIABLE = 0x80;
const KEYWORDS = 0x4750d8;
const KEYWORD_SIZE = 24;

/** The keyword table at 0x4750d8 (24-byte records up to the first one without a name). */
export function readScriptKeywords(exe: PeImage): ScriptKeyword[] {
  const keywords: ScriptKeyword[] = [];
  for (let va = KEYWORDS; ; va += KEYWORD_SIZE) {
    const record = readVa(exe, va, KEYWORD_SIZE);
    const name = decodeCp437(record.subarray(0, NAME_SIZE)).replace(/\0.*$/s, "");
    if (!/^[A-Za-z]/.test(name)) return keywords;
    const view = new DataView(record.buffer, record.byteOffset, KEYWORD_SIZE);
    keywords.push({
      name,
      flags: view.getUint32(12, true),
      address: view.getUint32(16, true),
      args: view.getUint32(20, true),
    });
  }
}

/**
 * Script object names (O_X) the sound tables do not name, by class: their values are the
 * tile types of these classes in each episode (O_SAND is 39 in Junior, 49 elsewhere), as
 * read from the compiled scripts.
 */
export const SCRIPT_OBJECT_CLASSES: Readonly<Record<string, number>> = {
  ALIEN: 2,
  ANDROID: 45,
  ARROW: 24,
  BLINK: 233,
  BOMB: 19,
  BORDER: 6,
  DEALER: 44,
  EGG: 65,
  ELEC: 7,
  ISOLATE: 9,
  LCDOOR: 231,
  LOCK: 22,
  MKROBOT: 47,
  PASS: 225,
  RAIL: 208,
  SAND: 39,
  SLOT: 210,
  STAIR: 71,
  TLOCK: 194,
  TRAIN: 221,
  WALL2: 215,
  WALL3: 216,
  WOOD: 91,
  WORM: 69,
};

/**
 * The events of `Event(mask)` (0x408970), as constants every script knows. Ours, not the
 * game's: the original scripts write the numbers (`Event(1+2+8)`), and like the O_ names
 * they compile to plain numbers.
 */
export const SCRIPT_EVENTS: ReadonlyMap<string, number> = new Map([
  ["EV_TAKE", 1],
  ["EV_DROP", 2],
  ["EV_AREA", 4],
  ["EV_ROOM", 8],
  ["EV_SLOT", 16],
]);

/**
 * An episode's script constants ("O_KEY" -> tile type): the names of its sound table
 * (`objectNames`, Game.objectNames) and SCRIPT_OBJECT_CLASSES for its classes.
 */
export function scriptConstants(
  objectNames: ReadonlyMap<number, string>,
  classes: EpisodeClasses,
): Map<string, number> {
  const constants = new Map<string, number>();
  for (const [name, id] of Object.entries(SCRIPT_OBJECT_CLASSES)) {
    const type = classes.typeOfClass.get(id);
    if (type !== undefined) constants.set(`O_${name}`, type);
  }
  for (const [type, name] of objectNames) constants.set(`O_${name}`, type);
  return constants;
}

/**
 * The cells a script's SetObj calls place (the first argument, tile type | state << 8)
 * where it is a constant expression: numbers, `constants` (O_STAIR | 0x0100) and C's
 * operators. 0, which removes the top object, is left out, as are values the script
 * computes from variables.
 */
export function scriptPlacedObjects(
  source: string,
  constants: ReadonlyMap<string, number>,
): number[] {
  const code = scanScript(source).filter((p) => p.kind !== "space" && p.kind !== "comment");
  const placed: number[] = [];
  code.forEach((piece, i) => {
    if (piece.kind !== "name" || piece.text.toUpperCase() !== "SETOBJ") return;
    if (code[i + 1]?.text !== "(") return;
    // the first argument: up to its comma
    const arg: ScriptPiece[] = [];
    let depth = 0;
    for (const p of code.slice(i + 2)) {
      if (depth === 0 && (p.text === "," || p.text === ")")) break;
      if (p.text === "(") depth++;
      if (p.text === ")") depth--;
      arg.push(p);
    }
    const value = constantValue(arg, constants);
    if (value) placed.push(value & 0xffff);
  });
  return placed;
}

/** The value of a constant expression, undefined if it is none (or no expression). */
function constantValue(
  code: readonly ScriptPiece[],
  constants: ReadonlyMap<string, number>,
): number | undefined {
  let t = 0;
  const unary = (): number | undefined => {
    const piece = code[t++] as ScriptPiece | undefined;
    if (piece === undefined) return undefined;
    if (piece.kind === "number") return Number(piece.text) | 0;
    if (piece.kind === "name") return constants.get(piece.text);
    if (piece.text === "(") {
      const value = binary(0);
      return code[t++]?.text === ")" ? value : undefined;
    }
    const operand = unary();
    if (operand === undefined) return undefined;
    if (piece.text === "-") return -operand | 0;
    if (piece.text === "~") return ~operand;
    if (piece.text === "!") return operand ? 0 : 1;
    return undefined;
  };
  const binary = (level: number): number | undefined => {
    if (level === BINARY_LEVELS.length) return unary();
    let left = binary(level + 1);
    while (left !== undefined && BINARY_LEVELS[level].includes(code[t]?.text ?? "")) {
      const op = code[t++].text;
      const right = binary(level + 1);
      left = right === undefined ? undefined : apply(op, left, right);
    }
    return left;
  };
  const value = binary(0);
  return t === code.length ? value : undefined;
}

/** A binary operator on 32-bit integers as in C, undefined for a division by zero. */
function apply(op: string, a: number, b: number): number | undefined {
  switch (op) {
    case "||":
      return a || b ? 1 : 0;
    case "&&":
      return a && b ? 1 : 0;
    case "|":
      return a | b;
    case "^":
      return a ^ b;
    case "&":
      return a & b;
    case "==":
      return a === b ? 1 : 0;
    case "!=":
      return a !== b ? 1 : 0;
    case "<":
      return a < b ? 1 : 0;
    case "<=":
      return a <= b ? 1 : 0;
    case ">":
      return a > b ? 1 : 0;
    case ">=":
      return a >= b ? 1 : 0;
    case "<<":
      return a << b;
    case ">>":
      return a >> b;
    case "+":
      return (a + b) | 0;
    case "-":
      return (a - b) | 0;
    case "*":
      return Math.imul(a, b);
    default:
      return b === 0 ? undefined : op === "/" ? (a / b) | 0 : (a % b) | 0;
  }
}

// --- compiler ---------------------------------------------------------------------------

type Token =
  | { kind: "name"; text: string; at: number }
  | { kind: "number"; value: number; at: number }
  | { kind: "string"; text: string; at: number }
  | { kind: "punct"; text: string; at: number }
  | { kind: "end"; at: number };

/** A piece of script source, for showing it (scanScript covers every character). */
export interface ScriptPiece {
  kind: "space" | "comment" | "name" | "number" | "string" | "punct" | "invalid";
  text: string;
  at: number;
}

const PIECES: readonly (readonly [ScriptPiece["kind"], RegExp])[] = [
  ["space", /[\s\0]+/y],
  ["comment", /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*/y],
  ["name", /[A-Za-z_]\w*/y],
  ["number", /0[xX][0-9a-fA-F]+|\d+/y],
  ["string", /"[^"]*"?/y],
  ["punct", /&&|\|\||==|!=|<=|>=|<<|>>|[-+*/%&|^~!<>=(){};,?:]/y],
];

/** Splits source into pieces; unknown characters become "invalid" pieces. */
export function scanScript(source: string): ScriptPiece[] {
  const pieces: ScriptPiece[] = [];
  let i = 0;
  while (i < source.length) {
    let text: string | undefined;
    let kind: ScriptPiece["kind"] = "invalid";
    for (const [k, pattern] of PIECES) {
      pattern.lastIndex = i;
      text = pattern.exec(source)?.[0];
      if (text) {
        kind = k;
        break;
      }
    }
    text ??= source[i];
    pieces.push({ kind, text, at: i });
    i += text.length;
  }
  return pieces;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const fail = (message: string, at: number): never => {
    throw new ScriptError(`${message} at ${position(source, at)}`, at);
  };
  for (const { kind, text, at } of scanScript(source)) {
    if (kind === "space") continue;
    if (kind === "comment") {
      if (text.startsWith("/*") && (text.length < 4 || !text.endsWith("*/")))
        fail("unterminated comment", at);
    } else if (kind === "string") {
      if (text.length < 2 || !text.endsWith('"')) fail("unterminated string", at);
      tokens.push({ kind, text: text.slice(1, -1), at });
    } else if (kind === "number") {
      tokens.push({ kind, value: Number(text), at });
    } else if (kind === "invalid") {
      fail(`unexpected ${JSON.stringify(text)}`, at);
    } else {
      tokens.push({ kind, text, at });
    }
  }
  tokens.push({ kind: "end", at: source.length });
  return tokens;
}

function position(source: string, at: number): string {
  const before = source.slice(0, at).split("\n");
  return `line ${before.length}, column ${(before.at(-1)?.length ?? 0) + 1}`;
}

/** Binary operators by precedence, loosest first (C's, without the comma). */
const BINARY_LEVELS: readonly (readonly string[])[] = [
  ["||"],
  ["&&"],
  ["|"],
  ["^"],
  ["&"],
  ["==", "!="],
  ["<", "<=", ">", ">="],
  ["<<", ">>"],
  ["+", "-"],
  ["*", "/", "%"],
];

/** An instruction before layout; jumps refer to labels. */
type Emitted = { op: number; operand: number; text?: string } | { jump: number; label: number };

export interface CompileOptions {
  /** Named constants (O_KEY = 21, ...), replaced by their values; SCRIPT_EVENTS too. */
  constants?: ReadonlyMap<string, number>;
  /**
   * The game's keywords: names starting with an upper-case letter must be one of them
   * (the game's linker rejects the scene otherwise); unchecked if absent.
   */
  keywords?: readonly ScriptKeyword[];
}

/** Whether the linker looks a name up (isupper, 0x45791e) or makes it a local variable. */
const isKeywordName = (name: string) => /^[A-Z]/.test(name);

/**
 * Compiles a room script the way the game's own compiler did (all 128 original scripts
 * come out byte for byte): symbols in order of first appearance, every value pushed with
 * the smallest operand, no folding of constants, no short-circuit evaluation (&& and ||
 * are plain operators). Statements: expressions (with `=`, calls and `?:`), `if`/`else`,
 * `for`, `return`, blocks; comments in C style. Strings and `for` without a condition
 * compile but appear in no original script.
 */
export function compileScript(source: string, options: CompileOptions = {}): Uint8Array {
  const tokens = tokenize(source);
  const constants = options.constants ?? new Map<string, number>();
  const symbols: ScriptSymbol[] = [];
  const out: Emitted[] = [];
  const labels: number[] = [];
  let t = 0;

  const peek = () => tokens[t];
  const fail = (message: string, token = peek()): never => {
    throw new ScriptError(`${message} at ${position(source, token.at)}`, token.at);
  };
  const isPunct = (text: string, token = peek()) => token.kind === "punct" && token.text === text;
  const isWord = (text: string, token = peek()) => token.kind === "name" && token.text === text;
  const accept = (text: string) => {
    if (!isPunct(text)) return false;
    t++;
    return true;
  };
  const expect = (text: string) => {
    if (!accept(text)) fail(`expected "${text}"`);
  };
  const emit = (op: number, operand = 0) => {
    out.push({ op, operand });
  };
  const label = () => labels.push(-1) - 1;
  const place = (l: number) => {
    labels[l] = out.length;
  };
  const jump = (op: number, l: number) => {
    out.push({ jump: op, label: l });
  };

  const symbol = (name: string, kind: number, args: number) => {
    // like the game's linker, case-insensitive; the first spelling is kept
    let index = symbols.findIndex((s) => s.name.toUpperCase() === name.toUpperCase());
    if (index < 0) {
      if (name.length > NAME_SIZE) fail(`name longer than ${NAME_SIZE} characters: ${name}`);
      index = symbols.push({ name, kind, args }) - 1;
    } else if (symbols[index].kind !== kind) {
      fail(`${name} used as a variable and a function`);
    }
    return index;
  };

  // symbols are numbered in order of appearance, so a name is entered when it is read
  const primary = (): void => {
    const token = peek();
    t++;
    if (token.kind === "number") {
      emit(Op.PUSH, token.value | 0);
      return;
    }
    if (token.kind === "string") {
      out.push({ op: Op.STRING, operand: token.text.length, text: token.text });
      return;
    }
    if (token.kind === "name") {
      if (isPunct("(")) {
        t++;
        // entered now, the argument count is known after the arguments
        const index = symbol(token.text, SymbolKind.FUNCTION, -1);
        let args = 0;
        if (!accept(")")) {
          do {
            assignment();
            emit(Op.ARG);
            args++;
          } while (accept(","));
          expect(")");
        }
        const entry = symbols[index];
        if (entry.args < 0) entry.args = args;
        else if (entry.args !== args)
          fail(`${token.text} has ${args} arguments here, ${entry.args} before`, token);
        emit(Op.CALL, index);
        emit(Op.DROP, args);
        return;
      }
      const constant = constants.get(token.text) ?? SCRIPT_EVENTS.get(token.text);
      if (constant !== undefined) {
        emit(Op.PUSH, constant);
        return;
      }
      if (/^(?:O|EV)_/.test(token.text)) fail(`unknown constant ${token.text}`, token);
      emit(Op.LOAD, symbol(token.text, SymbolKind.VARIABLE, 0));
      return;
    }
    if (token.kind === "punct" && token.text === "(") {
      assignment();
      expect(")");
      return;
    }
    fail("expected a value", token);
  };

  const unary = (): void => {
    for (const [text, op] of [
      ["!", OPERATORS["!"]],
      ["~", OPERATORS["~"]],
      ["-", OPERATORS["neg"]],
    ] as const) {
      if (accept(text)) {
        unary();
        emit(op);
        return;
      }
    }
    accept("+");
    primary();
  };

  const binary = (level: number): void => {
    if (level === BINARY_LEVELS.length) {
      unary();
      return;
    }
    binary(level + 1);
    for (;;) {
      const token = peek();
      const op =
        token.kind === "punct" && BINARY_LEVELS[level].includes(token.text)
          ? token.text
          : undefined;
      if (!op) return;
      t++;
      binary(level + 1);
      emit(OPERATORS[op]);
    }
  };

  const conditional = (): void => {
    binary(0);
    if (!accept("?")) return;
    const otherwise = label();
    const end = label();
    jump(Op.JUMP_IF_FALSE, otherwise);
    assignment();
    expect(":");
    jump(Op.JUMP, end);
    place(otherwise);
    conditional();
    place(end);
  };

  const assignment = (): void => {
    const token = peek();
    if (token.kind === "name" && isPunct("=", tokens[t + 1])) {
      t += 2;
      const index = symbol(token.text, SymbolKind.VARIABLE, 0);
      assignment();
      emit(Op.STORE, index);
      return;
    }
    conditional();
  };

  const statement = (): void => {
    if (accept("{")) {
      while (!accept("}")) {
        if (peek().kind === "end") fail('expected "}"');
        statement();
      }
      return;
    }
    if (accept(";")) return;
    if (isWord("if")) {
      t++;
      expect("(");
      assignment();
      expect(")");
      const otherwise = label();
      jump(Op.JUMP_IF_FALSE, otherwise);
      statement();
      if (isWord("else")) {
        t++;
        const end = label();
        jump(Op.JUMP, end);
        place(otherwise);
        statement();
        place(end);
      } else {
        place(otherwise);
      }
      return;
    }
    if (isWord("for")) {
      // init; cond: test, to end if false, to body; step: step, to cond; body: body, to step
      t++;
      expect("(");
      if (!isPunct(";")) assignment();
      expect(";");
      const test = label();
      const step = label();
      const body = label();
      const end = label();
      place(test);
      if (!isPunct(";")) assignment();
      else emit(Op.PUSH, 1);
      expect(";");
      jump(Op.JUMP_IF_FALSE, end);
      jump(Op.JUMP, body);
      place(step);
      if (!isPunct(")")) assignment();
      expect(")");
      jump(Op.JUMP, test);
      place(body);
      statement();
      jump(Op.JUMP, step);
      place(end);
      return;
    }
    if (isWord("return")) {
      t++;
      if (!isPunct(";")) assignment();
      expect(";");
      emit(Op.END);
      return;
    }
    assignment();
    expect(";");
  };

  while (peek().kind !== "end") statement();
  emit(Op.END);
  if (options.keywords) checkKeywords(symbols, options.keywords);
  return layout(symbols, out, labels);
}

function checkKeywords(symbols: readonly ScriptSymbol[], keywords: readonly ScriptKeyword[]) {
  for (const s of symbols) {
    const isFunction = s.kind === SymbolKind.FUNCTION;
    if (!isFunction && !isKeywordName(s.name)) continue;
    const same = keywords.filter((k) => k.name.toUpperCase() === s.name.toUpperCase());
    const found = isFunction
      ? same.some((k) => k.flags & KEYWORD_FUNCTION && k.args === s.args)
      : same.some((k) => k.flags & KEYWORD_VARIABLE);
    if (found) continue;
    if (same.length === 0)
      throw new ScriptError(
        isFunction
          ? `unknown function ${s.name}`
          : `unknown variable ${s.name} (local variables start in lower case)`,
      );
    throw new ScriptError(
      isFunction
        ? `${s.name} takes ${same.map((k) => k.args).join(" or ")} arguments, not ${s.args}`
        : `${s.name} is not a variable`,
    );
  }
}

function operandSize(value: number): number {
  if (value === 0) return 0;
  if (value >= -0x80 && value < 0x80) return 1;
  if (value >= -0x8000 && value < 0x8000) return 2;
  return 4;
}

function encode(bytes: number[], op: number, operand: number, size = operandSize(operand)): void {
  bytes.push(op | (OPERAND_SIZES.indexOf(size as 0 | 1 | 2 | 4) << 4));
  for (let i = 0; i < size; i++) bytes.push((operand >> (8 * i)) & 0xff);
}

/**
 * Bytes of the symbol table and code. Jump sizes are chosen from a first layout with
 * 2-byte jumps, as the game's compiler did (some jumps of less than 128 bytes have 2-byte
 * operands because jumps between them shrank afterwards).
 */
function layout(
  symbols: readonly ScriptSymbol[],
  out: readonly Emitted[],
  labels: readonly number[],
): Uint8Array {
  const head: number[] = [];
  encode(head, Op.SYMBOLS, symbols.length);
  for (const s of symbols) {
    const name = encodeCp437(s.name);
    for (let i = 0; i < NAME_SIZE; i++) head.push(name[i] ?? 0);
    head.push(s.kind, s.args);
  }
  const length = (e: Emitted, jumpSize: number) =>
    "jump" in e
      ? 1 + jumpSize
      : isOperator(e.op)
        ? 1
        : 1 + operandSize(e.operand) + (e.text?.length ?? 0);
  const place = (jumpSizes: readonly number[]) => {
    const offsets: number[] = [];
    let pc = head.length;
    for (const [i, e] of out.entries()) {
      offsets.push(pc);
      pc += length(e, jumpSizes[i]);
    }
    offsets.push(pc);
    const distance = (i: number) => {
      const e = out[i];
      return "jump" in e ? offsets[labels[e.label]] - offsets[i + 1] : 0;
    };
    return distance;
  };
  const first = place(out.map(() => 2));
  const jumpSizes = out.map((_, i) => operandSize(first(i)));
  const distance = place(jumpSizes);
  const bytes = [...head];
  for (const [i, e] of out.entries()) {
    if ("jump" in e) encode(bytes, e.jump, distance(i), jumpSizes[i]);
    else if (isOperator(e.op)) bytes.push(e.op);
    else {
      encode(bytes, e.op, e.operand);
      if (e.text !== undefined) bytes.push(...encodeCp437(e.text));
    }
  }
  return new Uint8Array(bytes);
}
