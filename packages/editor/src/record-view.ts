import {
  type EpisodeClasses,
  type LogicRecord,
  TANGRAM_TILE,
  describeRecord,
  teleporterCondition,
} from "@robot/formats";

import { patchChildren } from "./patch.ts";

/** The record types of oracles and teleporters. */
const ORACLE = 12;
const TELEPORTER = 13;
/** Texts: an oracle's hint (+ the low 4 bits of its state), a teleporter's message. */
const ORACLE_HINTS = 330;
const TELEPORTER_MESSAGES = 1200;

/** A record field shown as an input: a cell value (hex), a number, a flag or a choice. */
interface Field {
  label: string;
  kind: "cell" | "number" | "room" | "flag" | "choice";
  /** The range of values; min defaults to 0. */
  min?: number;
  max: number;
  get: (d: Uint8Array) => number;
  set: (d: Uint8Array, value: number) => void;
  hint?: string;
  /** The values of a choice and their names. */
  choices?: readonly (readonly [value: number, name: string])[];
  /** Whether the game ignores the field, given the record's other fields. */
  ignored?: (d: Uint8Array) => boolean;
  /** The text the field names, shown next to it; undefined: none. */
  text?: (d: Uint8Array) => number | undefined;
}

const u16 = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
const setU16 = (d: Uint8Array, at: number, v: number) => {
  d[at] = v & 0xff;
  d[at + 1] = v >> 8;
};

const cell = (at: number, label: string, hint?: string): Field => ({
  label,
  kind: "cell",
  max: 0xffff,
  get: (d) => u16(d, at),
  set: (d, v) => {
    setU16(d, at, v);
  },
  ...(hint === undefined ? {} : { hint }),
});

const byte = (at: number, label: string, max = 255, hint?: string): Field => ({
  label,
  kind: "number",
  max,
  get: (d) => d[at],
  set: (d, v) => {
    d[at] = v;
  },
  ...(hint === undefined ? {} : { hint }),
});

/** Target room in bits 0-9 of the u16 at offset 4. */
const targetRoom: Field = {
  label: "Target room",
  kind: "room",
  max: 0x3ff,
  get: (d) => u16(d, 4) & 0x3ff,
  set: (d, v) => {
    setU16(d, 4, (u16(d, 4) & 0xfc00) | v);
  },
};

/** Arrival x in bits 10-15 of the u16 at offset 4. */
const packedX: Field = {
  label: "Arrival x",
  kind: "number",
  max: 39,
  get: (d) => u16(d, 4) >> 10,
  set: (d, v) => {
    setU16(d, 4, (u16(d, 4) & 0x3ff) | (v << 10));
  },
};

/** Bit `bit` of byte `at` as a checkbox. */
const flag = (at: number, bit: number, label: string, hint?: string): Field => ({
  label,
  kind: "flag",
  max: 1,
  get: (d) => (d[at] >> bit) & 1,
  set: (d, v) => {
    d[at] = (d[at] & ~(1 << bit)) | (v << bit);
  },
  ...(hint === undefined ? {} : { hint }),
});

/** Byte 1 bit 5, the same for every type. */
const goneAfterLeaving = flag(
  1,
  5,
  "Gone after leaving",
  "when the hero leaves the room, the record is dropped and only its cell (offset 2) stays, " +
    "a plain cell that does nothing (the game sets it on the exits travelling actors leave open)",
);

interface RecordType {
  type: number;
  name: string;
  fields: readonly Field[];
}

/** The record types by number and their fields (see records.ts in @robot/formats). */
export const RECORD_TYPES: readonly RecordType[] = (
  [
    {
      type: 13,
      name: "Teleporter",
      fields: [
        cell(2, "Cell"),
        {
          ...byte(
            7,
            "Condition",
            255,
            "carry item: only a hero who carries an item like the cell (any state) can step " +
              "on it, drawn on white; do not carry item: only one who carries none, drawn on black",
          ),
          kind: "choice",
          choices: [
            [0, "none"],
            [1, "carry item"],
            [2, "do not carry item"],
          ],
        },
        targetRoom,
        packedX,
        byte(6, "Arrival y", 28),
        flag(
          1,
          1,
          "Script may set the target",
          "a script's Teleport(room, x, y) (room not 0) replaces the target",
        ),
        {
          ...flag(
            1,
            0,
            "Always enterable",
            "the hero can step on it whatever the cell is (e.g. a wall or water hiding a " +
              "passage) and first steps onto the cell as if it lay there (e.g. picks up the " +
              "item shown), then he is teleported; unchecked, he can step on it only where the " +
              "cell lets him (not on a wall), and the cell stays; ignored with a condition",
          ),
          ignored: (d) => teleporterCondition(d) !== "none",
        },
        flag(
          1,
          3,
          "Glows in the dark",
          "lights a circle around it in a dark room (episode III only)",
        ),
        {
          ...byte(
            8,
            "Message",
            255,
            "0: none, else message 1200 + this when used (not when redirected)",
          ),
          text: (d) => (d[8] ? TELEPORTER_MESSAGES + d[8] : undefined),
        },
      ],
    },
    {
      type: 12,
      name: "Oracle",
      fields: [
        cell(
          2,
          "Cell",
          "tile 0x51; the low 4 bits of its state (n) pick the symbol, the hint and the event " +
            "262 + n (3500 points once per game); bit 4: the symbol counts as found",
        ),
        {
          label: "Hint (eastwards)",
          kind: "number",
          min: ORACLE_HINTS,
          max: ORACLE_HINTS + 15,
          get: (d) => ORACLE_HINTS + (d[3] & 15),
          set: (d, v) => {
            d[3] = (d[3] & 0xf0) | (v - ORACLE_HINTS);
          },
          hint:
            "the message shown when it is walked into eastwards: 330 + the low 4 bits of the " +
            "cell's state, which also pick its symbol (330-339; from 340 on there is none " +
            "to lay, see Symbol found)",
          text: (d) => ORACLE_HINTS + (d[3] & 15),
        },
        flag(
          3,
          4,
          "Symbol found",
          "it works without its symbol being laid in the room; the game sets it once it finds " +
            "the symbol (bit 4 of the cell's state)",
        ),
        { ...targetRoom, hint: "walked into northwards" },
        packedX,
        byte(6, "Arrival y", 28),
        cell(8, "Turns into", "walked into westwards"),
      ],
    },
    {
      type: 8,
      name: "Travelling actor",
      fields: [
        cell(2, "Cell", "placed when the room is entered"),
        targetRoom,
        byte(6, "Target x", 39),
        byte(7, "Target y", 28),
        byte(
          8,
          "Actor",
          255,
          "0x80 + n: the episode's actor n (0x83 dealer, 0x85 thief); else a tile type",
        ),
      ],
    },
    {
      type: 7,
      name: "Native",
      fields: [
        cell(2, "Cell", "placed when the room is entered"),
        cell(4, "Sells", "the object he offers after a few chats; 0: none"),
        byte(6, "Price", 15, "in gold (counts up to 9)"),
        byte(7, "Chatter", 15, "his texts: 300 + this or 310 + this"),
      ],
    },
    {
      type: 5,
      name: "Spawner",
      fields: [
        cell(2, "Cell"),
        byte(4, "Radius²", 255, "a robot appears while the hero's squared distance is below this"),
        byte(5, "Period", 255, "ticks between robots"),
        byte(6, "Countdown", 255, "ticks until the next robot"),
        byte(7, "Animation", 255, "its animation phase (set by the game)"),
      ],
    },
    {
      type: 3,
      name: "Buried",
      fields: [
        cell(2, "Visible cell"),
        cell(4, "Buried cell", "dug up with the shovel: then it lies on the visible cell"),
      ],
    },
    {
      type: 1,
      name: "Stacked",
      fields: [
        cell(4, "Top cell", "shown; taking it leaves the lower cell"),
        cell(2, "Lower cell"),
        {
          label: "Level",
          kind: "number",
          max: 3,
          get: (d) => d[1] >> 6,
          set: (d, v) => {
            d[1] = (d[1] & 0x3f) | (v << 6);
          },
          hint: "of the top object: actors reach it only from this level up (bridges)",
        },
      ],
    },
    {
      type: 11,
      name: "Circuit node",
      fields: [
        cell(2, "Cell"),
        flag(
          1,
          0,
          "Final node",
          "its stairs appear once every node in the room is on, itself included (a normal " +
            "node's stairs: while it is on); only the room's last final node counts",
        ),
        byte(4, "Stairs x", 39),
        byte(5, "Stairs y", 28, "0: no stairs"),
        {
          label: "Stairs up",
          kind: "flag",
          max: 1,
          get: (d) => (d[6] ? 1 : 0),
          set: (d, v) => {
            d[6] = v;
          },
          hint: "stairs up to room id - 100; unchecked: stairs down to room id + 100",
        },
        byte(
          7,
          "Last signal",
          255,
          "set by the game, keep 0: it acts only when a node's signal changes from this",
        ),
      ],
    },
  ] satisfies RecordType[]
)
  .map((t) => ({ ...t, fields: [...t.fields, goneAfterLeaving] }))
  .sort((a, b) => a.type - b.type);

export interface RecordViewEvents {
  change(data: Uint8Array): void;
  add(type: number): void;
  remove(): void;
  go(room: number): void;
  /** A canvas showing a cell value. */
  preview(value: number): HTMLCanvasElement;
  /** The tile the editor paints with. */
  tile(): number;
  /** Makes a cell value the tile the editor paints with. */
  useTile(value: number): void;
  /** The episode's text `id` as one paragraph, undefined if it has none. */
  text(id: number): string | undefined;
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

const hex = (value: number, digits = 4) => `0x${value.toString(16).padStart(digits, "0")}`;

function parseNumber(text: string, kind: Field["kind"]): number {
  const t = text.trim();
  return kind === "cell" || /^0x/i.test(t) ? Number.parseInt(t.replace(/^0x/i, ""), 16) : Number(t);
}

/** The inspector for the selected cell's logic record (or for adding one). */
export class RecordView {
  readonly element = element("section", "record-view");
  private readonly events: RecordViewEvents;
  /** The shown record's bytes, as edited; the controls' listeners work on these. */
  private data = new Uint8Array(0);
  /** Which record is shown (slot, cell, type): shown again, its controls are kept. */
  private shown: string | undefined;

  constructor(events: RecordViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Logic record");
    this.element.hidden = true;
  }

  hide(): void {
    this.element.hidden = true;
    this.element.replaceChildren();
    this.shown = undefined;
  }

  private commit(): void {
    this.events.change(this.data.slice());
  }

  /**
   * Shows a record of an episode with these classes and oracle symbols
   * (readOracleSymbols); `where` names the cell, e.g. "(12, 7) base".
   */
  show(
    record: LogicRecord,
    where: string,
    classes: EpisodeClasses,
    symbols?: readonly (readonly number[])[],
  ): void {
    this.element.hidden = false;
    const data = record.data.slice();
    this.data = data;
    const known = RECORD_TYPES.find((t) => t.type === data[0]);

    const title = element("h3", undefined, `Logic record ${record.slot} at ${where}`);
    const summary = element(
      "p",
      "record-summary",
      describeRecord(record, classes, symbols).summary,
    );
    const type = typeSelect(known ? undefined : data[0]);
    type.value = String(data[0]);
    type.addEventListener("change", () => {
      this.data[0] = Number(type.value);
      this.commit();
    });

    const fields = (known?.fields ?? []).map((field) => this.field(field));
    const symbol = data[0] === ORACLE ? symbols?.[data[3] & 15] : undefined;
    if (symbol) {
      const block = element("span", "oracle-symbol");
      block.title = "Lay these tangram pieces as a 2×2 block anywhere in the room";
      block.append(...symbol.map((s) => this.events.preview(TANGRAM_TILE | (s << 8))));
      fields.push(labelled("Symbol", block));
    }

    const raw = element("input", "record-bytes");
    raw.setAttribute("aria-label", "Record bytes");
    raw.spellcheck = false;
    raw.value = [...data].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    raw.addEventListener("change", () => {
      const bytes = raw.value
        .trim()
        .split(/\s+/)
        .map((b) => Number.parseInt(b, 16));
      if (bytes.length === this.data.length && bytes.every((b) => b >= 0 && b <= 255)) {
        this.data.set(bytes);
        this.commit();
      } else {
        raw.value = [...this.data].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      }
    });

    const remove = element("button", undefined, "Remove record");
    remove.className = "danger";
    remove.addEventListener("click", () => {
      this.events.remove();
    });

    const children = [
      title,
      summary,
      labelled("Type", type),
      ...fields,
      labelled("Bytes", raw),
      remove,
    ];
    // the same record again (after an edit): keep the controls, so focus stays and Tab
    // goes on to the next field
    const shown = `${record.slot} ${where} ${data[0]}`;
    if (shown === this.shown) patchChildren(this.element, children);
    else this.element.replaceChildren(...children);
    this.shown = shown;
  }

  /** Offers to add a record to a plain cell. */
  showEmpty(where: string): void {
    this.element.hidden = false;
    const type = typeSelect();
    type.value = String(TELEPORTER);
    const add = element("button", undefined, "Add record");
    add.addEventListener("click", () => {
      this.events.add(Number(type.value));
    });
    this.shown = undefined;
    this.element.replaceChildren(
      element("h3", undefined, `No logic record at ${where}`),
      element(
        "p",
        "hint",
        "A new record goes into the base layer (the game drops records in the overlay) and shows the cell it replaces; its other fields start at 0.",
      ),
      labelled("Type", type),
      add,
    );
  }

  private field(field: Field): HTMLElement {
    const data = this.data;
    const value = field.get(data);
    if (field.kind === "choice") {
      const select = element("select");
      select.setAttribute("aria-label", field.label);
      const choices = field.choices ?? [];
      for (const [v, name] of choices) select.append(new Option(name, String(v)));
      if (!choices.some(([v]) => v === value))
        select.append(new Option(String(value), String(value)));
      select.value = String(value);
      select.addEventListener("change", () => {
        field.set(this.data, Number(select.value));
        this.commit();
      });
      return labelled(field.label, select, field.hint);
    }
    if (field.kind === "flag") {
      const box = element("input");
      box.type = "checkbox";
      box.checked = value !== 0;
      box.disabled = field.ignored?.(data) ?? false;
      box.addEventListener("change", () => {
        field.set(this.data, box.checked ? 1 : 0);
        this.commit();
      });
      return labelled(field.label, box, field.hint);
    }
    const input = element("input", "record-field");
    input.setAttribute("aria-label", field.label);
    input.spellcheck = false;
    input.value = field.kind === "cell" ? hex(value) : String(value);
    input.addEventListener("change", () => {
      const v = parseNumber(input.value, field.kind);
      if (Number.isInteger(v) && v >= (field.min ?? 0) && v <= field.max) {
        field.set(this.data, v);
        this.commit();
      } else {
        input.value =
          field.kind === "cell" ? hex(field.get(this.data)) : String(field.get(this.data));
      }
    });
    const extras: HTMLElement[] = [];
    if (field.kind === "cell") {
      // click: take the current tile; right-click: paint with this one
      const preview = this.events.preview(value);
      preview.classList.add("pickable");
      preview.title += "\nClick: take the current tile · Right-click: paint with this one";
      preview.addEventListener("click", (event) => {
        event.preventDefault(); // inside the label: do not focus the input
        field.set(this.data, this.events.tile());
        this.commit();
      });
      preview.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.events.useTile(field.get(this.data));
      });
      extras.push(preview);
    }
    const textId = field.text?.(data);
    if (textId !== undefined) {
      // the text the field names, as the game shows it
      const text = this.events.text(textId);
      const shown = element("span", "record-text", text ?? "(none in this episode)");
      shown.title = text === undefined ? `text ${textId}` : `text ${textId}: ${text}`;
      extras.push(shown);
    }
    if (field.kind === "room" && value !== 0) {
      const go = element("button", undefined, "Go");
      go.addEventListener("click", () => {
        this.events.go(field.get(this.data));
      });
      extras.push(go);
    }
    return labelled(field.label, input, field.hint, ...extras);
  }
}

/** The record types by number; `unknown`, if given, among them. */
function typeSelect(unknown?: number): HTMLSelectElement {
  const select = element("select");
  select.setAttribute("aria-label", "Record type");
  const types = RECORD_TYPES.map((t) => [t.type, `${t.type} ${t.name}`] as const);
  if (unknown !== undefined) types.push([unknown, `${unknown} unknown`]);
  for (const [value, name] of types.sort((a, b) => a[0] - b[0]))
    select.append(new Option(name, String(value)));
  return select;
}

function labelled(text: string, control: HTMLElement, hint?: string, ...extras: HTMLElement[]) {
  const label = element("label", "record-row");
  label.dataset["key"] = text;
  label.append(element("span", "record-label", text), control, ...extras);
  if (hint) label.title = hint;
  return label;
}
