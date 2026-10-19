import { type EpisodeClasses, type LogicRecord, describeRecord } from "@robot/formats";

/** A record field shown as an input: a cell value (hex), a number or a flag. */
interface Field {
  label: string;
  kind: "cell" | "number" | "room" | "flag";
  max: number;
  get: (d: Uint8Array) => number;
  set: (d: Uint8Array, value: number) => void;
  hint?: string;
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

/** The record types and their fields (see records.ts in @robot/formats). */
export const RECORD_TYPES: readonly { type: number; name: string; fields: readonly Field[] }[] = [
  {
    type: 13,
    name: "Teleporter",
    fields: [
      cell(2, "Cell"),
      targetRoom,
      packedX,
      byte(6, "Arrival y", 28),
      {
        label: "Return to the saved point",
        kind: "flag",
        max: 1,
        get: (d) => (d[1] >> 1) & 1,
        set: (d, v) => {
          d[1] = (d[1] & ~2) | (v << 1);
        },
        hint: "goes back to a point the game saved at run time, if there is one",
      },
      byte(7, "Description variant"),
      byte(8, "Message", 255, "0: none, else message 0x4b0 + this"),
    ],
  },
  {
    type: 12,
    name: "Oracle",
    fields: [cell(2, "Cell"), targetRoom, packedX, byte(6, "Arrival y", 28)],
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
    name: "Creature",
    fields: [
      cell(2, "Cell", "placed when the room is entered"),
      cell(4, "Parameter"),
      byte(6, "Parameter 2", 15),
      byte(7, "Parameter 3", 15),
    ],
  },
  {
    type: 5,
    name: "Spawner",
    fields: [
      cell(2, "Cell"),
      byte(4, "Radius²", 255, "a creature appears while the hero's squared distance is below this"),
      byte(5, "Period", 255, "ticks between creatures"),
      byte(6, "Countdown", 255, "ticks until the first creature"),
      byte(7, "State"),
    ],
  },
  {
    type: 3,
    name: "Buried",
    fields: [cell(2, "Visible cell"), cell(4, "Buried cell", "found by digging with the shovel")],
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
        hint: "compared with the actor stepping on it",
      },
    ],
  },
  { type: 11, name: "Circuit node", fields: [cell(2, "Cell"), byte(7, "Signal")] },
];

export interface RecordViewEvents {
  change(data: Uint8Array): void;
  add(type: number): void;
  remove(): void;
  go(room: number): void;
  /** A canvas showing a cell value. */
  preview(value: number): HTMLCanvasElement;
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

  /** Shows a record of an episode with these classes; `where` names the cell, e.g. "(12, 7) base". */
  show(record: LogicRecord, where: string, classes: EpisodeClasses): void {
    this.element.hidden = false;
    const data = record.data.slice();
    const known = RECORD_TYPES.find((t) => t.type === data[0]);
    const commit = () => {
      this.events.change(data.slice());
    };

    const title = element("h3", undefined, `Logic record ${record.slot} at ${where}`);
    const summary = element("p", "record-summary", describeRecord(record, classes).summary);
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
      element("p", "hint", "A new record shows the cell it replaces; its other fields start at 0."),
      labelled("Type", type),
      add,
    );
  }

  private field(field: Field, data: Uint8Array, commit: () => void): HTMLElement {
    const value = field.get(data);
    if (field.kind === "flag") {
      const box = element("input");
      box.type = "checkbox";
      box.checked = value !== 0;
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
