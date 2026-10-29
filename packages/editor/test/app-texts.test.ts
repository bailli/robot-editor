import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import { parseMod, readEpisodeStart } from "@robot/formats";

import { app, game, roomNameField, useApp } from "./app-setup.ts";
import { defined } from "./game.ts";

useApp();

const texts = () => page.getByRole("region", { name: "Texts" });
const status = () => document.querySelector(".status")?.textContent;
const entries = () =>
  [...document.querySelectorAll<HTMLElement>(".text-list .text-number")].map((e) =>
    Number(e.textContent),
  );

async function openText(entry: number) {
  await userEvent.fill(texts().getByLabelText("Find text"), String(entry));
  await texts()
    .getByRole("button", { name: new RegExp(`^${entry}(?!\\d)`) })
    .first()
    .click();
}

test("an entry found, written, taken back to the exe's; saved into the mod", async () => {
  app.showEpisode(1, 43);
  await page.getByRole("tab", { name: "Texts" }).click();
  // by number, by words
  await userEvent.fill(texts().getByLabelText("Find text"), "51");
  expect(entries()).toEqual(expect.arrayContaining([51, 510, 511]));
  await userEvent.fill(texts().getByLabelText("Find text"), "510");
  expect(entries()).toEqual([510]);
  await userEvent.fill(texts().getByLabelText("Find text"), "keine Beschreibung");
  expect(entries()).toContain(510);
  await openText(510);
  await expect.element(texts().getByRole("heading", { name: "Text 510" })).toBeVisible();
  await expect.element(texts().getByText("Description of tiles without one")).toBeVisible();
  const field = texts().getByLabelText("Text", { exact: true });
  await expect.element(field).toHaveValue(defined(game.texts(1110)?.entries.get(510)?.[0]));
  const apply = texts().getByRole("button", { name: "Apply" });
  await expect.element(apply).toBeDisabled();
  // what the format cannot store is said, and not applied
  await userEvent.fill(field, "Nichts; gar nichts.");
  await expect.element(texts().getByText(/^Cannot write it: "\|" and ";"/)).toBeVisible();
  await expect.element(apply).toBeDisabled();
  await userEvent.fill(field, "Nichts zu sehen @06.");
  // the tile in it drawn as the game draws it
  expect(document.querySelectorAll(".text-preview canvas")).toHaveLength(1);
  await apply.click();
  expect(app.editor?.textEntry(1110, 510)).toEqual(["Nichts zu sehen @06."]);
  expect(status()).toBe("Text 510 written");
  await expect.element(texts().getByText(/^Written here/)).toBeVisible();
  expect(parseMod(app.saveMod() ?? "").changes.texts).toEqual([
    { resource: 1110, entry: 510, variants: ["Nichts zu sehen @06."] },
  ]);
  // a second variant, then the exe's text again
  await texts().getByRole("button", { name: "Add variant" }).click();
  await userEvent.fill(texts().getByLabelText("Variant 2"), "  Gar nichts.  ");
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  expect(app.editor?.textEntry(1110, 510)).toEqual(["Nichts zu sehen @06.", "Gar nichts."]);
  await texts().getByRole("button", { name: "Original" }).click();
  expect(app.editor?.textState(1110, 510)?.written).toBe(false);
  await expect.element(texts().getByText("As the exe has it.")).toBeVisible();
  // undo brings the written text back into the open entry
  app.undo();
  await expect.element(texts().getByLabelText("Variant 2")).toHaveValue("Gar nichts.");
  // Escape: the draft first, then back to the list
  await userEvent.fill(texts().getByLabelText("Variant 2"), "Etwas.");
  await userEvent.keyboard("{Escape}");
  await expect.element(texts().getByLabelText("Variant 2")).toHaveValue("Gar nichts.");
  await userEvent.keyboard("{Escape}");
  await expect.element(texts().getByLabelText("Find text")).toBeVisible();
  await expect.element(texts().getByText("written", { exact: true })).toBeVisible();
});

test("a new entry, a removed one; names and descriptions follow", async () => {
  app.showEpisode(1, 43);
  await page.getByRole("tab", { name: "Texts" }).click();
  await userEvent.fill(texts().getByLabelText("Find text"), "900");
  await texts().getByRole("button", { name: "Write text 900" }).click();
  await expect.element(texts().getByText(/^A new entry/)).toBeVisible();
  await userEvent.fill(texts().getByLabelText("Text", { exact: true }), "Ein neuer Zettel.");
  await texts().getByRole("button", { name: "Apply" }).click();
  expect(app.editor?.textEntry(1110, 900)).toEqual(["Ein neuer Zettel."]);
  await texts().getByRole("button", { name: "Remove" }).click();
  expect(app.editor?.textState(1110, 900)).toBeUndefined();
  // the room's name: the title follows
  await texts().getByRole("button", { name: "← All texts" }).click();
  await openText(1043);
  await expect.element(texts().getByText(/^Name of room 43/)).toBeVisible();
  await userEvent.fill(texts().getByLabelText("Text", { exact: true }), "NEUER START");
  await texts().getByRole("button", { name: "Apply" }).click();
  expect(roomNameField().value).toBe("NEUER START");
  // a tile's description: the palette's tooltip follows
  await texts().getByRole("button", { name: "← All texts" }).click();
  await openText(6);
  await expect.element(texts().getByText(/^Description of tile type 0x06/)).toBeVisible();
  await texts().getByRole("button", { name: "Remove variant 2" }).click();
  await userEvent.fill(texts().getByLabelText("Text", { exact: true }), "Eine Mauer.");
  await texts().getByRole("button", { name: "Apply" }).click();
  const tile = document.querySelector<HTMLElement>('.tile-grid button[data-tile="6"]');
  expect(tile?.title).toMatch(/\nEine Mauer\.$/);
  expect(
    app.editor
      ?.textStates(1110)
      .filter((s) => s.written)
      .map((s) => s.entry),
  ).toEqual([6, 1043]);
  await expect
    .element(page.getByRole("tab", { name: "Texts" }))
    .toHaveAttribute("title", expect.stringMatching(/^2 entries written here/));
});

test("episode III: room names, diary pages and event texts in their own resource", async () => {
  app.showEpisode(3, 41);
  await page.getByRole("tab", { name: "Texts" }).click();
  await userEvent.selectOptions(texts().getByLabelText("Resource"), "1320");
  await openText(2);
  await expect.element(texts().getByText("Diary page 2")).toBeVisible();
  await texts().getByRole("button", { name: "← All texts" }).click();
  await openText(1041);
  await expect.element(texts().getByText(/^Name of room 41/)).toBeVisible();
  // longer than the game reads: said, not applied
  await userEvent.fill(texts().getByLabelText("Text", { exact: true }), "x ".repeat(600));
  await expect.element(texts().getByText(/at most 999 characters/)).toBeVisible();
});

test("jumps: a record's text, the cell's texts, a script's message, an event's text", async () => {
  // the oracle's hint, from the record inspector; back to the Record tab
  app.showEpisode(3, 48);
  await page.getByRole("tab", { name: "Record" }).click();
  const room = game.room(3, 48);
  const oracle = defined(room.records.find((r) => r.data[0] === 12));
  app.select(room.base.findIndex((c) => c === (0x7f | (oracle.slot << 8))));
  const hint = 330 + (oracle.data[3] & 15);
  await page
    .getByRole("button", { name: `Write text ${hint}` })
    .first()
    .click();
  expect(app.sidePanel.shown).toBe("texts");
  await expect.element(texts().getByRole("heading", { name: `Text ${hint}` })).toBeVisible();
  await texts().getByRole("button", { name: "← Record" }).click();
  expect(app.sidePanel.shown).toBe("record");
  // a draft not applied stays: another jump is refused
  await page.getByRole("tab", { name: "Texts" }).click();
  await userEvent.fill(texts().getByLabelText("Text", { exact: true }), "Ein Tipp.");
  await page.getByRole("tab", { name: "Record" }).click();
  app.editText(1310, 510);
  expect(status()).toMatch(new RegExp(`^Text ${hint} has changes not applied`));
  await expect.element(texts().getByRole("heading", { name: `Text ${hint}` })).toBeVisible();
  await texts().getByRole("button", { name: "Cancel" }).click();

  // the selected cell's texts: a note's message and its description
  const notes = game.episode(1).rooms.flatMap((r) =>
    [r.base, r.overlay].flatMap((layer) => {
      const at = layer.findIndex((c) => (c & 0xff) === 58);
      return at < 0 ? [] : [{ id: r.id, at, cell: layer[at] ?? 0 }];
    }),
  );
  const note = defined(notes[0], "a note in episode I");
  app.showEpisode(1, note.id);
  await page.getByRole("tab", { name: "Record" }).click();
  app.select(note.at);
  const cell = page.getByRole("region", { name: "Texts of the cell" });
  const message = 800 + ((note.cell >> 8) & 0x7f);
  await expect.element(cell.getByText(new RegExp(`message, text ${message}:`))).toBeVisible();
  await cell.getByRole("button", { name: `Write text ${message}` }).click();
  await expect.element(texts().getByRole("heading", { name: `Text ${message}` })).toBeVisible();
  await expect.element(texts().getByText(/^Message, of notes in state/)).toBeVisible();

  // a script's message number, Ctrl+clicked (episode I room 43: Message(700, 25))
  app.showEpisode(1, 43);
  await page.getByRole("tab", { name: "Script" }).click();
  const number = defined(
    [...document.querySelectorAll<HTMLElement>(".script-source .number")].find(
      (e) => e.textContent === "700",
    ),
  );
  const box = number.getBoundingClientRect();
  const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2 };
  number.dispatchEvent(new MouseEvent("mousedown", { ...at, bubbles: true, ctrlKey: true }));
  expect(app.sidePanel.shown).toBe("texts");
  await expect.element(texts().getByRole("heading", { name: "Text 700" })).toBeVisible();
  await texts().getByRole("button", { name: "← Script" }).click();

  // an event copied from another episode: its text
  const ivRoom = readEpisodeStart(game.image, 4).room;
  app.editor?.copyEvent(4, ivRoom, 197, { from: 2, of: 135 });
  app.showEpisode(4, ivRoom);
  await page.getByRole("tab", { name: "Episode" }).click();
  await page.getByRole("button", { name: "Write the text of entry 197" }).click();
  await expect.element(texts().getByRole("heading", { name: "Text 1997" })).toBeVisible();
  await expect.element(texts().getByText(/^Text of event entry 197/)).toBeVisible();
  await expect.element(texts().getByText(/^A copy of text 1935 of Robot II/)).toBeVisible();
});
