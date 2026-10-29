/** A group of the help: rows of keys (" / " between alternatives) and what they do. */
interface HelpGroup {
  title: string;
  rows: readonly (readonly [keys: string, action: string])[];
}

const HELP: readonly HelpGroup[] = [
  {
    title: "Rooms",
    rows: [
      ["← ↑ → ↓", "Go through the room's exit that does not depend on the game state"],
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
      ["5", "Episode (the dealer)"],
      ["6", "Texts (with an entry open: Escape back to the list)"],
      ["7", "Actors"],
      ["8", "Circuit"],
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

/** Shows the keys and mouse buttons of the editor in a dialog; Escape or Close ends it. */
export function showHelp(): void {
  if (document.querySelector("dialog.help-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.className = "help-dialog";
  dialog.setAttribute("aria-label", "Shortcuts");
  const form = document.createElement("form");
  form.method = "dialog";
  const heading = document.createElement("h2");
  heading.textContent = "Shortcuts";
  form.append(heading);
  for (const group of HELP) {
    const table = document.createElement("table");
    const caption = table.createCaption();
    caption.textContent = group.title;
    for (const [keys, action] of group.rows) {
      const row = table.insertRow();
      const cell = row.insertCell();
      keys.split(" / ").forEach((alternative, i) => {
        if (i > 0) cell.append(" / ");
        const kbd = document.createElement("kbd");
        kbd.textContent = alternative;
        cell.append(kbd);
      });
      row.insertCell().textContent = action;
    }
    form.append(table);
  }
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
  close.focus();
}
