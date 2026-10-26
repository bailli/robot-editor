import {
  MAX_DARKNESS,
  MAX_VISIT_POINTS,
  POINTS_STEP,
  RoomFlag,
  type RoomSettings,
} from "@robot/formats";

export interface SettingsViewEvents {
  /** The user changed one setting (Editor.setRoomSettings). */
  change(settings: Partial<RoomSettings>): void;
  /** The user changed the description (Editor.setRoomDescription). */
  describe(description: string): void;
}

/** What the view needs to know about the room's episode. */
export interface SettingsContext {
  episode: number;
  /** The pieces of the episode's MUSIC resource. */
  pieces: readonly string[];
  /** Pieces some room of the game plays (listed first: these are songs). */
  roomMusic: ReadonlySet<string>;
  /** When the original editor saved the room. */
  saved?: Date | undefined;
  /** The description of the room's name (lines joined by "\n"); undefined: it has none to give. */
  description: string | undefined;
  /** What the description field is about, or why it is off. */
  descriptionNote: string;
}

/** Episodes whose rooms have no music in the originals. */
const SILENT_EPISODES = [0, 1];
/** The episode whose code reads the flags (kind 3). */
const FLAGS_EPISODE = 3;

const FLAGS: readonly { flag: number; label: string; hint: string }[] = [
  {
    flag: RoomFlag.DIZZY,
    label: "Hero gets dizzy",
    hint: "message 944 after 15 s in the room, once per game, unless three herb tubers were eaten",
  },
  {
    flag: RoomFlag.LABYRINTH,
    label: "Labyrinth",
    hint: "entering from room 146 builds a new maze of walls and teleporters over the rooms from 144 on (the original: room 144; not tried in the game)",
  },
];

function row(label: string, title: string, ...children: Node[]): HTMLElement {
  const element = document.createElement("label");
  element.className = "record-row";
  element.title = title;
  const name = document.createElement("span");
  name.className = "record-label";
  name.textContent = label;
  element.append(name, ...children);
  return element;
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}

/** The Room tab: the settings a room keeps in its tags (see room-tags.ts). */
export class SettingsView {
  readonly element = document.createElement("div");
  private readonly darkness = document.createElement("input");
  private readonly points = document.createElement("input");
  private readonly music = document.createElement("select");
  private readonly musicNote = note("");
  private readonly flags = document.createElement("fieldset");
  private readonly flagInputs = new Map<number, HTMLInputElement>();
  private readonly saved = note("");
  private readonly description = document.createElement("textarea");
  private readonly descriptionNote = note("");
  private settings: RoomSettings | undefined;
  private shownDescription = "";

  constructor(events: SettingsViewEvents) {
    this.element.className = "settings-view record-view";
    const heading = document.createElement("h3");
    heading.textContent = "Room settings";
    for (const [input, max, step] of [
      [this.darkness, MAX_DARKNESS, 1],
      [this.points, MAX_VISIT_POINTS, POINTS_STEP],
    ] as const) {
      input.type = "number";
      input.min = "0";
      input.max = String(max);
      input.step = String(step);
      input.className = "record-field";
    }
    this.darkness.addEventListener("change", () => {
      events.change({ darkness: Number(this.darkness.value) });
    });
    this.points.addEventListener("change", () => {
      events.change({ points: Number(this.points.value) });
    });
    this.music.addEventListener("change", () => {
      events.change({ music: this.music.value });
    });
    this.description.className = "record-field room-description";
    this.description.rows = 6;
    this.description.spellcheck = false;
    this.description.setAttribute("aria-label", "Description");
    this.description.addEventListener("change", () => {
      events.describe(this.description.value);
    });
    this.description.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) this.description.blur();
      else if (event.key === "Escape") {
        this.description.value = this.shownDescription;
        this.description.blur();
      }
    });
    const descriptionHeading = document.createElement("h3");
    descriptionHeading.textContent = "Description";
    const legend = document.createElement("legend");
    legend.textContent = "Episode III";
    this.flags.className = "settings-flags";
    this.flags.append(legend);
    for (const { flag, label, hint } of FLAGS) {
      const input = document.createElement("input");
      input.type = "checkbox";
      input.addEventListener("change", () => {
        const flags = this.settings?.flags ?? 0;
        events.change({ flags: input.checked ? flags | flag : flags & ~flag });
      });
      this.flagInputs.set(flag, input);
      const element = document.createElement("label");
      element.title = hint;
      element.append(input, ` ${label}`);
      this.flags.append(element);
    }
    this.element.append(
      descriptionHeading,
      this.description,
      this.descriptionNote,
      heading,
      row(
        "Darkness",
        "Night on entering: 0 light to 100 dark (the originals use 40–100); scripts read and change it (Night, SetNight)",
        this.darkness,
      ),
      row(
        "First visit points",
        `Points the hero gets on the first visit, a multiple of ${POINTS_STEP} up to ${MAX_VISIT_POINTS}`,
        this.points,
      ),
      row(
        "Music",
        "Plays in a loop from entering the room; a piece already playing goes on; none or a name the episode lacks: silence",
        this.music,
      ),
      this.musicNote,
      this.flags,
      this.saved,
    );
  }

  show(settings: RoomSettings, context: SettingsContext): void {
    this.settings = settings;
    this.shownDescription = context.description ?? "";
    this.description.value = this.shownDescription;
    this.description.disabled = context.description === undefined;
    this.descriptionNote.textContent = context.descriptionNote;
    this.darkness.value = String(settings.darkness);
    this.points.value = String(settings.points);
    const option = (value: string, text = value) => {
      const element = document.createElement("option");
      element.value = value;
      element.textContent = text;
      return element;
    };
    const group = (label: string, pieces: readonly string[]) => {
      const element = document.createElement("optgroup");
      element.label = label;
      element.append(...pieces.map((p) => option(p)));
      return element;
    };
    const songs = context.pieces.filter((p) => context.roomMusic.has(p));
    const others = context.pieces.filter((p) => !context.roomMusic.has(p));
    const known = settings.music === "" || context.pieces.includes(settings.music);
    this.music.replaceChildren(
      option("", "none (silence)"),
      ...(known ? [] : [option(settings.music, `${settings.music} (missing: silence)`)]),
      group("Room music", songs),
      group("Other pieces (mostly sound effects)", others),
    );
    this.music.value = settings.music;
    this.musicNote.textContent = SILENT_EPISODES.includes(context.episode)
      ? "This episode's rooms play no music in the original; music here is not tried in the game."
      : "";
    this.musicNote.hidden = this.musicNote.textContent === "";
    this.flags.hidden = context.episode !== FLAGS_EPISODE;
    for (const [flag, input] of this.flagInputs) input.checked = (settings.flags & flag) !== 0;
    this.saved.textContent = context.saved
      ? `Saved by the original editor on ${context.saved.toISOString().slice(0, 10)}.`
      : "";
    this.saved.hidden = !context.saved;
  }
}
