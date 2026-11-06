import type { ConsoleObject } from "@robot/formats";

/**
 * A group of the help: rows of keys or commands (" / " between alternatives) and what
 * they do.
 */
interface HelpGroup {
  title: string;
  rows: readonly (readonly [keys: string, action: string])[];
}

/** The help's pages: the editor's keys, the game's console (the Console chip). */
export type HelpPage = "shortcuts" | "console";

const HELP: readonly HelpGroup[] = [
  {
    title: "Rooms",
    rows: [
      ["← ↑ → ↓", "Go through the room's exit that does not depend on the game state"],
      ["Page Down", "Go in through a door or down the stairs (room + 100)"],
      ["Page Up", "Go out through a door or up the stairs (room − 100)"],
      ["Backspace", "Back to the room before (Alt+← / Alt+→: the browser's back and forward)"],
      ["M", "Show or hide the map"],
    ],
  },
  {
    title: "Tools",
    rows: [
      ["P", "Paint"],
      ["F", "Fill"],
      ["S", "Select an area"],
      ["I", "Inspect: a click shows the cell's record, actor or circuit in its tab"],
      ["L", "Switch the layer: base or overlay"],
    ],
  },
  {
    title: "Room view",
    rows: [
      ["Left button", "Use the tool: paint (drag for lines), fill, select an area, inspect"],
      ["Right button / Alt+click", "Pick the cell's tile"],
      ["Ctrl+Z", "Undo"],
      ["Ctrl+Y / Ctrl+Shift+Z", "Redo"],
      ["Ctrl+S", "Save the exe"],
    ],
  },
  {
    title: "Selected area",
    rows: [
      ["Ctrl+C / Ctrl+X", "Copy or cut the area"],
      ["Ctrl+V", "Paste: a click puts the clip down, Shift+click keeps pasting"],
      ["Delete", "Clear the area"],
      ["Escape", "Stop pasting, else drop the selected area, else the selected cell"],
    ],
  },
  {
    title: "Show",
    rows: [
      ["G", "Grid"],
      ["D", "Rooms as dark as in the game"],
      ["A", "Actors"],
      ["W", "Where the hero can walk"],
      ["?", "This help"],
    ],
  },
  {
    title: "Side panel",
    rows: [
      ["1", "Tiles"],
      ["2", "Record (with no cell selected: the room's records)"],
      ["3", "Room"],
      ["4", "Script"],
      ["5", "Episode (its settings, the dealer)"],
      ["6", "Kits (and the tile types, events, music and code from other episodes)"],
      ["7", "Texts (with an entry open: Escape back to the list)"],
      ["8", "Actors"],
      ["9", "Circuit"],
    ],
  },
  {
    title: "Fields",
    rows: [
      ["Enter", "Room name: keep it; room id: go there"],
      ["Escape", "Room name: back to the old one"],
      ["Ctrl+Space", "Script: complete a name (Ctrl+Z and Ctrl+Y undo and redo in the script)"],
    ],
  },
];

/** The game's command console (STATUS.md, "Input, time and the driver"). */
const CONSOLE: readonly HelpGroup[] = [
  {
    title: "Places",
    rows: [
      ["SCENE n / SCENE n x y", "Go to room n (to cell x, y)"],
      ["DOWN / UP", "Go to the room id + 100 / − 100 (UP only from rooms above 100)"],
      ["LASTSCENE", "Back to the room before"],
      ["GO dx dy", "Move the hero by dx, dy cells"],
    ],
  },
  {
    title: "Objects (names below)",
    rows: [
      ["TAKE obj …", "Into the rucksack (as far as it holds them)"],
      ["DROP obj …", "Onto the hero's cell"],
      ["INFO obj / INFO n state", "Its description (n: a tile type)"],
      ["GOLD", "50 gold more"],
    ],
  },
  {
    title: "Hero and robots",
    rows: [
      ["LIFE", "3 lives"],
      ["ROBOTOFF", "Robots stand still for about 73 s"],
      ["KILL n", "Kill the room's actor n (0: the first, not the hero)"],
      ["SPEED n", "Food + n, where the episode has food (hungry, the hero slows down)"],
      ["DIGEST n", "The need for a toilet + n, where the episode has one"],
    ],
  },
  {
    title: "Game",
    rows: [
      ["SCORE n", "Points + n"],
      ["NIGHT n", "Darkness n (0: light, up to 100)"],
      ["ENIGMA n", "Event n as for the first time (points, sound, text)"],
      ["CLRENIGMA", "Every event can happen again"],
      ["UNSTORE n", "Room n as at the start when next entered"],
      ["BIRNBAUM", "Every diary page read"],
    ],
  },
  {
    title: "Texts",
    rows: [
      ["TEXT n / TEXT n m", "Text entry n (variant m)"],
      ["ROOMINFO n", "Room n's banner"],
      ["NOTE n", "Note n (message 800 + n)"],
      ["DIARY n", "Diary page n"],
    ],
  },
];

/**
 * Shows the help in a dialog, on `page`: the editor's keys and mouse buttons, or the
 * game's console commands with `objects`' names (the opened exe's); Escape or Close ends
 * it.
 */
export function showHelp(
  page: HelpPage = "shortcuts",
  objects: readonly ConsoleObject[] = [],
): void {
  if (document.querySelector("dialog.help-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "help-dialog";
  dialog.setAttribute("aria-label", "Help");
  const form = document.createElement("form");
  form.method = "dialog";
  const pages = { shortcuts: shortcutsPage(), console: consolePage(objects) };
  const tabs = document.createElement("fieldset");
  tabs.className = "segmented";
  const legend = document.createElement("legend");
  legend.textContent = "Help";
  tabs.append(legend);
  for (const [name, label] of [
    ["shortcuts", "Shortcuts"],
    ["console", "Console commands"],
  ] as const) {
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "help-page";
    radio.checked = name === page;
    radio.addEventListener("change", () => {
      pages.shortcuts.hidden = name !== "shortcuts";
      pages.console.hidden = name !== "console";
      dialog.scrollTop = 0;
    });
    const tab = document.createElement("label");
    tab.append(radio, label);
    tabs.append(tab);
  }
  pages.shortcuts.hidden = page !== "shortcuts";
  pages.console.hidden = page !== "console";
  form.append(tabs, pages.shortcuts, pages.console);
  const close = document.createElement("button");
  close.textContent = "Close";
  close.className = "primary";
  const buttons = document.createElement("div");
  buttons.className = "dialog-buttons";
  buttons.append(close);
  form.append(buttons);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("close", () => {
    dialog.remove();
  });
  dialog.showModal();
  close.focus({ preventScroll: true }); // the page from its top
}

function shortcutsPage(): HTMLElement {
  const section = document.createElement("section");
  section.setAttribute("aria-label", "Shortcuts");
  section.append(...HELP.map((group) => table(group, "kbd")));
  return section;
}

function consolePage(objects: readonly ConsoleObject[]): HTMLElement {
  const section = document.createElement("section");
  section.setAttribute("aria-label", "Console commands");
  const intro = document.createElement("p");
  intro.textContent =
    "With the Console chip on, “Test in game” starts the game with its command console: type a command in the bottom line, Return runs it, Backspace edits, Escape empties the line. While the console is on, letter keys go to it: pick rucksack items with the arrows. Commands and names may be written in any case, a letter as a state only in capitals: LETTER(B).";
  section.append(intro, ...CONSOLE.map((group) => table(group, "code")));
  const names = document.createElement("p");
  names.className = "console-objects";
  if (objects.length === 0) {
    names.textContent = "Open an exe to see the objects' names.";
  } else {
    names.append(
      "Objects (obj; each works in the episodes that have it; a range: one state of it, e.g. KEY(3)): ",
    );
    objects.forEach((object, i) => {
      if (i > 0) names.append(" ");
      const code = document.createElement("code");
      code.textContent = object.usage;
      names.append(code);
    });
  }
  section.append(names);
  return section;
}

/** A group as a table: its keys (`kbd`) or commands (`code`), and what they do. */
function table(group: HelpGroup, tag: "kbd" | "code"): HTMLTableElement {
  const table = document.createElement("table");
  table.createCaption().textContent = group.title;
  for (const [keys, action] of group.rows) {
    const row = table.insertRow();
    const cell = row.insertCell();
    keys.split(" / ").forEach((alternative, i) => {
      if (i > 0) cell.append(" / ");
      const element = document.createElement(tag);
      element.textContent = alternative;
      cell.append(element);
    });
    row.insertCell().textContent = action;
  }
  return table;
}
