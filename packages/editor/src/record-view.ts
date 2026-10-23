import {
  type EpisodeClasses,
  type LogicRecord,
  TANGRAM_TILE,
  describeRecord,
  teleporterCondition,
} from "@robot/formats";

/** Record types of oracles and teleporters. */
const ORACLE = 12;
const TELEPORTER = 13;
/** Texts: an oracle's hint (+ the low 4 bits of its state), a teleporter's message. */
const ORACLE_HINTS = 330;
const TELEPORTER_MESSAGES = 1200;

/** A record field shown as an input: a cell value (hex), a number, a flag or a choice. */
interface Field {
  label: string;
  kind: "cell" | "number" | "room" | "flag" | "choice";
  max: number;
  get: (d: Uint8Array) => number;
  set: (d: Uint8Array, value: number) => void;
  hint?: string;
  /** The values of a choice and their names. */
  choices?: readonly (readonly [value: number, name: string])[];
  /** Whether the game ignores the field, given the record's other fields. */
  ignored?: (d: Uint8Array) => boolean;
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

/** The record types and their fields (see records.ts in @robot/formats). */
export const RECORD_TYPES: readonly { type: number; name: string; fields: readonly Field[] }[] = [
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
      byte(8, "Message", 255, "0: none, else message 1200 + this when used (not when redirected)"),
    ],
  },
  {
    type: 12,
    name: "Oracle",
    fields: [
      cell(2, "Cell", "tile 0x51; its state's low 4 bits pick message 330 + n and the sound"),
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
];

export interface RecordViewEvents {
  change(data: Uint8Array): void;
  add(type: number): void;
  remove(): void;
  go(room: number): void;
  /** A canvas showing a cell value. */
  preview(value: number): HTMLCanvasElement;
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

  constructor(events: RecordViewEvents) {
    this.events = events;
    this.element.setAttribute("aria-label", "Logic record");
    this.element.hidden = true;
  }

  hide(): void {
    this.element.hidden = true;
    this.element.replaceChildren();
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
    const known = RECORD_TYPES.find((t) => t.type === data[0]);
    const commit = () => {
      this.events.change(data.slice());
    };

    const title = element("h3", undefined, `Logic record ${record.slot} at ${where}`);
    const summary = element(
      "p",
      "record-summary",
      describeRecord(record, classes, symbols).summary,
    );
    const type = element("select");
    type.setAttribute("aria-label", "Record type");
    for (const t of RECORD_TYPES) type.append(new Option(`${t.type} ${t.name}`, String(t.type)));
    if (!known) type.append(new Option(`${data[0]} unknown`, String(data[0])));
    type.value = String(data[0]);
    type.addEventListener("change", () => {
      data[0] = Number(type.value);
      commit();
    });

    const fields = (known?.fields ?? []).map((field) => this.field(field, data, commit));
    // the texts the record shows: an oracle's hint eastwards, a teleporter's message
    const message =
      data[0] === ORACLE
        ? { label: "Hint (eastwards)", id: ORACLE_HINTS + (data[3] & 15) }
        : data[0] === TELEPORTER && data[8]
          ? { label: "Message", id: TELEPORTER_MESSAGES + data[8] }
          : undefined;
    if (message) {
      const text = this.events.text(message.id);
      const shown = element("span", "record-text", text ?? "(none in this episode)");
      fields.push(labelled(`${message.label} ${message.id}`, shown, text));
    }
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
      if (bytes.length === data.length && bytes.every((b) => b >= 0 && b <= 255)) {
        data.set(bytes);
        commit();
      } else {
        raw.value = [...data].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      }
    });

    const remove = element("button", undefined, "Remove record");
    remove.className = "danger";
    remove.addEventListener("click", () => {
      this.events.remove();
    });

    this.element.replaceChildren(
      title,
      summary,
      labelled("Type", type),
      ...fields,
      labelled("Bytes", raw),
      remove,
    );
  }

  /** Offers to add a record to a plain cell. */
  showEmpty(where: string): void {
    this.element.hidden = false;
    const type = element("select");
    type.setAttribute("aria-label", "Record type");
    for (const t of RECORD_TYPES) type.append(new Option(`${t.type} ${t.name}`, String(t.type)));
    const add = element("button", undefined, "Add record");
    add.addEventListener("click", () => {
      this.events.add(Number(type.value));
    });
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

  private field(field: Field, data: Uint8Array, commit: () => void): HTMLElement {
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
        field.set(data, Number(select.value));
        commit();
      });
      return labelled(field.label, select, field.hint);
    }
    if (field.kind === "flag") {
      const box = element("input");
      box.type = "checkbox";
      box.checked = value !== 0;
      box.disabled = field.ignored?.(data) ?? false;
      box.addEventListener("change", () => {
        field.set(data, box.checked ? 1 : 0);
        commit();
      });
      return labelled(field.label, box, field.hint);
    }
    const input = element("input", "record-field");
    input.setAttribute("aria-label", field.label);
    input.spellcheck = false;
    input.value = field.kind === "cell" ? hex(value) : String(value);
    input.addEventListener("change", () => {
      const v = parseNumber(input.value, field.kind);
      if (Number.isInteger(v) && v >= 0 && v <= field.max) {
        field.set(data, v);
        commit();
      } else {
        input.value = field.kind === "cell" ? hex(field.get(data)) : String(field.get(data));
      }
    });
    const extras: HTMLElement[] = [];
    if (field.kind === "cell") extras.push(this.events.preview(value));
    if (field.kind === "room" && value !== 0) {
      const go = element("button", undefined, "Go");
      go.addEventListener("click", () => {
        this.events.go(field.get(data));
      });
      extras.push(go);
    }
    return labelled(field.label, input, field.hint, ...extras);
  }
}

function labelled(text: string, control: HTMLElement, hint?: string, ...extras: HTMLElement[]) {
  const label = element("label", "record-row");
  label.append(element("span", "record-label", text), control, ...extras);
  if (hint) label.title = hint;
  return label;
}
