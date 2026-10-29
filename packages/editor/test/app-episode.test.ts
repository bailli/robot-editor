import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import {
  EPISODE_VTABLES,
  NO_CHANGES,
  ROOM_WIDTH,
  SCREEN_WIDTH,
  TILE_HEIGHT,
  TILE_WIDTH,
  applyMod,
  emptyMod,
  parseMod,
  readDealer,
  readVa,
} from "@robot/formats";

import { app, bytes, clickCell, fireAt, game, useApp } from "./app-setup.ts";
import { defined } from "./game.ts";

useApp();

// saving offers a download: a link is clicked
beforeEach(() => {
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const tab = (name: string) => app.sidePanel.state(name);
const status = () => document.querySelector(".status")?.textContent;
const dealer = () => page.getByRole("region", { name: "Dealer" });
const price = (n: number) => dealer().getByLabelText(`Price of good ${n}`, { exact: true });

test("an episode whose backdrop methods are unknown loads; its backdrop checkbox is disabled", async () => {
  const va = EPISODE_VTABLES[0] ?? 0;
  const expectBytes = readVa(game.image, va, 4).slice();
  const code = [{ va, expect: expectBytes, bytes: Uint8Array.of(0, 0x10, 0x40, 0) }];
  const odd = applyMod(game.image, { ...emptyMod(bytes), changes: { ...NO_CHANGES, code } });
  app.load(odd);
  app.showEpisode(0, 1);
  await page.getByRole("tab", { name: "Episode" }).click();
  await expect.element(page.getByRole("checkbox", { name: /room 100 below/ })).toBeDisabled();
  expect(app.editor?.backdropRule(0)).toBeUndefined();
  expect(app.editor?.setBackdropRule(0, 1, "minus100")).toBeUndefined();
});

test("the Episode tab edits the dealer's goods, undoably; the mod keeps them", async () => {
  const original = defined(readDealer(game.image, 1));
  app.showEpisode(1, 43);
  await page.getByRole("tab", { name: "Episode" }).click();
  await expect.element(dealer().getByText("Dealers appear in rooms 18, 24, 42.")).toBeVisible();
  expect(document.querySelectorAll(".dealer-good").length).toBe(27);
  await expect.element(dealer().getByText("27 of 27")).toBeVisible();
  // the goods are classes, shown as the tiles the game makes of them
  const names = [...document.querySelectorAll(".dealer-name")].map((n) => n.textContent);
  expect(names.slice(14, 17)).toEqual(["Tonic", "Sickle", "Save"]);
  expect(names.at(-1)).toBe("Lamp");
  expect(names).not.toContain("Thief");
  // a tile without a class cannot be sold
  app.setTile(0);
  document
    .querySelector(".dealer-good canvas")
    ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(document.querySelector(".status")?.textContent).toBe(
    "The tile 0x0000 has no class: the dealer cannot sell it",
  );
  expect(app.editor?.dealer(1)).toEqual(original);
  await expect
    .element(dealer().getByRole("button", { name: "Add the current tile" }))
    .toBeDisabled();

  // a price: one undo step; the field stays the one focused
  const field = price(1).element();
  await userEvent.fill(price(1), "99");
  await userEvent.keyboard("{Tab}");
  expect(app.editor?.dealer(1)?.goods[0]).toEqual({ classId: 0x20, state: 0, price: 99 });
  expect(price(1).element()).toBe(field);
  expect(tab("episode")).toMatchObject({
    badge: "●",
    title: "Starts in room 43 at (5, 14); a rucksack of 50; the dealer sells 27 goods (edited)",
  });

  // the last good goes; the current tile replaces the first one; fewer shown
  const rows = () => document.querySelectorAll(".dealer-good");
  await dealer().getByRole("button", { name: "×" }).last().click();
  expect(rows().length).toBe(26);
  app.setTile(0x0315);
  defined(rows()[0].querySelector("canvas") ?? undefined).dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
  expect(app.editor?.dealer(1)?.goods[0]).toEqual({ classId: 0x15, state: 3, price: 99 });
  await userEvent.fill(dealer().getByLabelText("Shown at most"), "6");
  await userEvent.keyboard("{Enter}");
  expect(app.editor?.dealer(1)?.most).toBe(6);
  // room for one more now
  await dealer().getByRole("button", { name: "Add the current tile" }).click();
  expect(app.editor?.dealer(1)?.goods.at(-1)).toEqual({ classId: 0x15, state: 3, price: 10 });

  const saved = parseMod(app.saveMod() ?? "");
  expect(saved.changes.dealer.map((c) => [c.episode, c.goods.length, c.most])).toEqual([
    [1, 27, 6],
  ]);

  // undo, step by step, back to the exe's goods
  for (let i = 0; i < 5; i++) app.undo();
  expect(app.editor?.dealer(1)).toEqual(original);
  expect(tab("episode").badge).toBeUndefined();
  await expect.element(dealer().getByRole("button", { name: "Original goods" })).toBeDisabled();
});

test("the Episode tab sets the start to the shown room and the picked cell, undoably", async () => {
  const start = () => page.getByRole("region", { name: "Start" });
  app.showEpisode(1, 44);
  await page.getByRole("tab", { name: "Episode" }).click();
  await expect
    .element(start().getByText("Robot I starts in room", { exact: false }))
    .toHaveTextContent("Robot I starts in room 43, the hero at (5, 14).");
  // no cell picked: the start's cell, in the shown room
  await start().getByRole("button", { name: "Start here" }).click();
  expect(app.editor?.start(1)).toEqual({ room: 44, x: 5, y: 14 });
  expect(status()).toBe("The episode now starts in room 44 at (5, 14)");
  // a cell picked with Select
  app.setArea({ x: 20, y: 10, w: 1, h: 1 });
  await start().getByRole("button", { name: "Start here" }).click();
  expect(app.editor?.start(1)).toEqual({ room: 44, x: 20, y: 10 });
  expect(tab("episode")).toMatchObject({
    badge: "●",
    title: "Starts in room 44 at (20, 10) (edited); a rucksack of 50; the dealer sells 27 goods",
  });
  expect(document.querySelector(".start-line")?.textContent).toBe(
    "Robot I starts in room 44, the hero at (20, 10) (edited).",
  );
  // the start cell is marked: its frame's left edge in green
  const marked = (x: number, y: number) => {
    const zoom = app.view.zoom;
    const at =
      (y * TILE_HEIGHT + TILE_HEIGHT / 2) * zoom * SCREEN_WIDTH * zoom + x * TILE_WIDTH * zoom + 1;
    return [...app.view.pixelsOfMarks().slice(at * 4, at * 4 + 4)];
  };
  app.setArea(undefined);
  expect(marked(20, 10)).toEqual([0, 170, 60, 255]);
  const saved = parseMod(app.saveMod() ?? "");
  expect(saved.changes.start).toEqual([{ episode: 1, room: 44, x: 20, y: 10 }]);
  // back to the exe's start, then undone step by step
  await start().getByRole("button", { name: "Original start" }).click();
  expect(app.editor?.start(1)).toEqual({ room: 43, x: 5, y: 14 });
  expect(app.roomId).toBe(43);
  expect(marked(5, 14)).toEqual([0, 170, 60, 255]);
  app.undo();
  expect(app.editor?.start(1)).toEqual({ room: 44, x: 20, y: 10 });
  app.undo();
  app.undo();
  expect(app.editor?.start(1)).toEqual({ room: 43, x: 5, y: 14 });
  expect(tab("episode").badge).toBeUndefined();
  await expect.element(start().getByRole("button", { name: "Original start" })).toBeDisabled();
});

test("the Episode tab sets the rucksack and the oracles' flags, undoably; the mod keeps them", async () => {
  app.showEpisode(0, 43);
  await page.getByRole("tab", { name: "Episode" }).click();
  const rucksack = page.getByRole("region", { name: "Rucksack" });
  const oracles = page.getByRole("region", { name: "Flags" });
  await expect.element(rucksack.getByLabelText("Capacity")).toHaveValue(38);
  await userEvent.fill(rucksack.getByLabelText("Capacity"), "12");
  await userEvent.keyboard("{Enter}");
  expect(app.editor?.rucksack(0)).toBe(12);
  // out of range: the field goes back
  await userEvent.fill(rucksack.getByLabelText("Capacity"), "251");
  await userEvent.keyboard("{Enter}");
  expect(app.editor?.rucksack(0)).toBe(12);
  await expect.element(rucksack.getByLabelText("Capacity")).toHaveValue(12);
  await oracles.getByRole("checkbox", { name: /sending the hero/ }).click();
  await oracles.getByRole("checkbox", { name: /their hint/ }).click();
  expect(app.editor?.episodeFlags(0)).toBe(0x4801e946);
  await oracles.getByRole("checkbox", { name: /without the key/ }).click();
  await oracles.getByRole("checkbox", { name: /sprite's colours/ }).click();
  expect(app.editor?.episodeFlags(0)).toBe(0x4809e966);
  // Junior's Teleport() points: cleared on entering a room, as everywhere but in III
  await expect.element(oracles.getByRole("checkbox", { name: /only in their room/ })).toBeChecked();
  await expect
    .element(oracles.getByRole("checkbox", { name: /block from room 100/ }))
    .not.toBeChecked();
  await oracles.getByRole("checkbox", { name: /Diagonal moves/ }).click();
  expect(app.editor?.diagonalMoves(0)).toBe(true);
  app.undo();
  await oracles.getByRole("checkbox", { name: /room 100 below/ }).click();
  expect(app.editor?.backdropRule(0)).toBe("minus100");
  app.undo();
  expect(tab("episode")).toMatchObject({ badge: "●" });
  expect(tab("episode").title).toMatch(/a rucksack of 12, settings edited/);
  const saved = parseMod(app.saveMod() ?? "");
  expect(saved.changes.rucksack).toEqual([{ episode: 0, capacity: 12 }]);
  expect(saved.changes.flags).toEqual([{ episode: 0, flags: 0x4809e966 }]);
  await oracles.getByRole("checkbox", { name: /without the key/ }).click();
  await oracles.getByRole("checkbox", { name: /sprite's colours/ }).click();
  for (let i = 0; i < 7; i++) app.undo();
  expect(app.editor?.rucksack(0)).toBe(38);
  expect(app.editor?.episodeFlags(0)).toBe(0x48012946);
  await expect
    .element(oracles.getByRole("checkbox", { name: /sending the hero/ }))
    .not.toBeChecked();
  expect(tab("episode").badge).toBeUndefined();
});

test("the Episode tab copies tile types of other episodes, undoably; the mod keeps them", async () => {
  app.showEpisode(0, 43);
  await page.getByRole("tab", { name: "Episode" }).click();
  const types = page.getByRole("region", { name: "Tile types" });
  await expect
    .element(types.getByText("Robot Junior has no tile types of other episodes."))
    .toBeVisible();
  await userEvent.selectOptions(types.getByLabelText("From episode"), "II");
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x51));
  // the same number, free in Junior
  await expect.element(types.getByLabelText("To type")).toHaveValue(String(0x51));
  await types.getByRole("button", { name: "Copy" }).click();
  await app.idle();
  expect(app.editor?.tileTypeCopies(0)).toEqual([{ episode: 0, to: 0x51, from: 2, of: 0x51 }]);
  expect(app.editor?.game.episode(0).classes.classes.get(0x51)?.id).toBe(
    game.episode(2).classes.classes.get(0x51)?.id,
  );
  expect(document.querySelectorAll(".side-episode .dealer-good").length).toBeGreaterThan(0);
  // the copy is in the tile list, in each state its shape draws (the oracle: 10)
  const listed = [...document.querySelectorAll<HTMLElement>(".tile-grid button")].map((b) =>
    Number(b.dataset["tile"]),
  );
  expect(listed.filter((t) => (t & 0xff) === 0x51)).toEqual(
    Array.from({ length: 10 }, (_, k) => 0x51 | (k << 8)),
  );
  const saved = parseMod(app.saveMod() ?? "");
  expect(saved.changes.tileTypes).toEqual([{ episode: 0, from: 2, types: [[0x51, 0x51]] }]);
  // removed with ×, back with undo, gone with another
  await types.getByRole("button", { name: "×" }).click();
  await app.idle();
  expect(app.editor?.tileTypeCopies(0)).toEqual([]);
  app.undo();
  expect(app.editor?.tileTypeCopies(0)).toHaveLength(1);
  app.undo();
  expect(app.editor?.tileTypeCopies(0)).toEqual([]);
  expect(app.editor?.game).toBe(app.editor?.pristine);
  expect(document.querySelector('.tile-grid [data-tile="81"]')).toBeNull();
});

test("the copy form's target: the same number where free, else the first type no copy has", async () => {
  app.showEpisode(0, 43);
  await page.getByRole("tab", { name: "Episode" }).click();
  const types = page.getByRole("region", { name: "Tile types" });
  const to = types.getByLabelText("To type");
  await userEvent.selectOptions(types.getByLabelText("From episode"), "II");
  // types 0x01 and 0x02 have classes in Junior: the first free type, 0x3a (0x39 lies in room 51)
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x01));
  await expect.element(to).toHaveValue(String(0x3a));
  await types.getByRole("button", { name: "Copy" }).click();
  await app.idle();
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x02));
  await expect.element(to).toHaveValue(String(0x3b));
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x50));
  await expect.element(to).toHaveValue(String(0x50));
  app.undo();
  // a free type painted into a room is no longer offered, again once undone
  const offered = () => [...(to.element() as HTMLSelectElement).options].map((o) => o.value);
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x01));
  expect(offered()).toContain(String(0x3a));
  app.setTile(0x3a);
  await clickCell(5 * ROOM_WIDTH + 20);
  expect(offered()).not.toContain(String(0x3a));
  app.undo();
  expect(offered()).toContain(String(0x3a));
});

test("the Episode tab copies events of other episodes to spare entries, undoably", async () => {
  const start = app.editor?.start(4).room ?? 0;
  app.showEpisode(4, start);
  await page.getByRole("tab", { name: "Episode" }).click();
  const events = page.getByRole("region", { name: "Events" });
  await expect.element(events.getByText(/has no events of other episodes/)).toBeVisible();
  await userEvent.selectOptions(events.getByLabelText("From episode"), "II");
  // II's entry 135: an oracle's event 263, with its text
  await userEvent.selectOptions(events.getByLabelText("Event"), "135");
  await expect.element(events.getByLabelText("To entry")).toHaveValue("197");
  await events.getByRole("button", { name: "Copy" }).click();
  await app.idle();
  expect(app.editor?.eventEntries(4)).toEqual([
    { episode: 4, entry: 197, id: 263, points: 3500, text: { from: 2, of: 135 } },
  ]);
  await expect.element(events.getByText("197 ← II 135: event 263, 3500 points")).toBeVisible();
  expect(status()).toMatch(/Entry 197 is now entry 135 of/);
  // the copied event is no longer offered; the next copy goes to the next spare entry
  const offered = [...(events.getByLabelText("Event").element() as HTMLSelectElement).options].map(
    (o) => o.value,
  );
  expect(offered).not.toContain("135");
  await expect.element(events.getByLabelText("To entry")).toHaveValue("198");
  const saved = parseMod(app.saveMod() ?? "");
  expect(saved.changes.events).toEqual([{ episode: 4, entry: 197, id: 263, points: 3500 }]);
  expect(saved.changes.copyTexts).toEqual([
    { resource: 1410, from: 1210, entries: [[1997, 1935]] },
  ]);
  // removed with ×, back with undo, gone with another
  await events.getByRole("button", { name: "×" }).click();
  await app.idle();
  expect(app.editor?.eventEntries(4)).toEqual([]);
  app.undo();
  expect(app.editor?.eventEntries(4)).toHaveLength(1);
  app.undo();
  expect(app.editor?.eventEntries(4)).toEqual([]);
  expect(app.editor?.game).toBe(app.editor?.pristine);
  // II has no entry the game never uses
  app.showEpisode(2, 43);
  await expect.element(events.getByRole("button", { name: "Copy" })).toBeDisabled();
  await expect.element(events.getByText("0 spare")).toBeVisible();
});

test("the Texts tab copies texts of other episodes, a copied class's in one go", async () => {
  app.showEpisode(0, 43);
  await page.getByRole("tab", { name: "Texts" }).click();
  const types = page.getByRole("region", { name: "Tile types" });
  const texts = page.getByRole("region", { name: "Texts" });
  await expect.element(texts.getByText(/has no texts of other episodes/)).toBeVisible();
  // II's oracle in Junior: its hints and death message come with "Texts"
  await page.getByRole("tab", { name: "Episode" }).click();
  await userEvent.selectOptions(types.getByLabelText("From episode"), "II");
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x51));
  await types.getByRole("button", { name: "Copy" }).click();
  await app.idle();
  await types.getByRole("button", { name: "Texts" }).click();
  await app.idle();
  expect(app.editor?.textCopies(0).map((c) => c.to)).toEqual([331, 332, 334, 339, 945]);
  expect(status()).toMatch(/Texts 331, 332, 334, 339, 945 of .* copied/);
  await expect.element(types.getByRole("button", { name: "Texts" })).not.toBeInTheDocument();
  await page.getByRole("tab", { name: "Texts" }).click();
  await expect.element(texts.getByText(/^945 ← II: /)).toBeVisible();
  // one undo step
  app.undo();
  expect(app.editor?.textCopies(0)).toEqual([]);
  // the form: a text of II at another number, with what it would say
  await userEvent.selectOptions(texts.getByLabelText("From episode"), "II");
  await userEvent.fill(texts.getByLabelText("Text", { exact: true }), "331");
  await userEvent.keyboard("{Enter}");
  await expect.element(texts.getByLabelText("To text")).toHaveValue(331);
  await userEvent.fill(texts.getByLabelText("To text"), "340");
  await userEvent.keyboard("{Enter}");
  await texts.getByRole("button", { name: "Copy" }).click();
  await app.idle();
  expect(app.editor?.textCopies(0)).toEqual([{ to: 340, from: 2, of: 331 }]);
  const saved = parseMod(app.saveMod() ?? "");
  expect(saved.changes.copyTexts).toEqual([{ resource: 1010, from: 1210, entries: [[340, 331]] }]);
  // a text II lacks cannot be copied
  await userEvent.fill(texts.getByLabelText("Text", { exact: true }), "330");
  await userEvent.keyboard("{Enter}");
  await expect.element(texts.getByRole("button", { name: "Copy" })).toBeDisabled();
  await texts.getByRole("button", { name: "×" }).click();
  await app.idle();
  expect(app.editor?.textCopies(0)).toEqual([]);
  app.undo();
  app.undo();
  app.undo();
  expect(app.editor?.game).toBe(app.editor?.pristine);
});

test("the Episode tab adds kits: oracles with the symbols picked, then circuits", async () => {
  const start = app.editor?.start(4).room ?? 0;
  app.showEpisode(4, start);
  await page.getByRole("tab", { name: "Episode" }).click();
  const kits = page.getByRole("region", { name: "Kits" });
  // four spare entries for ten symbols: the first four are ticked, a fifth cannot be
  const symbol = (n: number) => kits.getByRole("checkbox", { name: `symbol ${n} (${262 + n})` });
  await expect.element(symbol(3)).toBeChecked();
  await expect.element(symbol(4)).toBeDisabled();
  for (const n of [0, 2, 3]) await symbol(n).click();
  await symbol(4).click();
  await kits.getByRole("button", { name: "Add oracles" }).click();
  await app.idle();
  expect(app.editor?.eventEntries(4).map((e) => [e.entry, e.id])).toEqual([
    [197, 263],
    [198, 266],
  ]);
  expect(app.editor?.tileTypeCopies(4).map((c) => c.of)).toEqual([0x50, 0x51]);
  expect(status()).toMatch(/Oracles of .* added to/);
  // the parts are in the lists below
  const types = page.getByRole("region", { name: "Tile types" });
  await expect.element(types.getByText(/0x6d ← II 0x51/)).toBeVisible();
  // circuits take the next spare entry
  await expect.element(kits.getByText("Events: 293 in entry 199")).toBeVisible();
  await kits.getByRole("button", { name: "Add circuits" }).click();
  await app.idle();
  expect(app.editor?.eventEntries(4).map((e) => e.id)).toEqual([263, 266, 293]);
  // one undo step each
  app.undo();
  app.undo();
  expect(app.editor?.game).toBe(app.editor?.pristine);
  // II has both
  app.showEpisode(2, 43);
  await expect.element(kits.getByText("Robot II has oracles already.")).toBeVisible();
  await expect.element(kits.getByText("Robot II has circuits already.")).toBeVisible();
});

test("a kit's example is placed like a paste, once the episode has the kit", async () => {
  app.showEpisode(3, 41);
  await page.getByRole("tab", { name: "Episode" }).click();
  const circuits = page.getByRole("region", { name: "Kits" }).getByRole("button", {
    name: "Place example",
  });
  // circuits: the second kit; III has oracles of its own, so their example is offered
  await expect.element(circuits.nth(1)).toBeDisabled();
  await expect.element(circuits.nth(0)).toBeEnabled();
  await page.getByRole("button", { name: "Add circuits" }).click();
  await app.idle();
  await circuits.nth(1).click();
  expect(app.pasting).toBe(true);
  const target = 10 * ROOM_WIDTH + 20;
  fireAt("mousemove", target);
  fireAt("mousedown", target);
  expect(app.pasting).toBe(false);
  expect(app.area).toEqual({ x: 20, y: 10, w: 7, h: 3 });
  // the node at (24, 11) with its stairs at (26, 11)
  const node = defined(app.editor)
    .room(3, 41)
    .records.find((r) => r.data[0] === 11 && r.data[5] === 11);
  expect(node?.data[4]).toBe(26);
  app.undo();
  app.undo();
  expect(app.editor?.game).toBe(app.editor?.pristine);
});

test("slow copies lock the side panel until they are done, saying what runs", async () => {
  app.showEpisode(0, 43);
  await page.getByRole("tab", { name: "Episode" }).click();
  const panel = app.sidePanel.element;
  // a DOM click runs the handler at once: the panel is locked before the work starts
  defined(page.getByRole("button", { name: "Add circuits" }).element() as HTMLElement).click();
  expect(panel.inert).toBe(true);
  expect(panel.classList.contains("busy")).toBe(true);
  expect(status()).toBe("Adding the circuits…");
  await app.idle();
  expect(panel.inert).toBe(false);
  expect(panel.classList.contains("busy")).toBe(false);
  expect(status()).toMatch(/Circuits of .* added to/);
  expect(app.editor?.tileTypeCopies(0)).toHaveLength(4);
  app.undo();
});

test("undo, redo and episode changes wait while the side panel's work runs", async () => {
  app.showEpisode(0, 43);
  const editor = defined(app.editor, "editor");
  editor.beginStroke(0, 43, "base");
  editor.paint(0, 0x0105);
  editor.endStroke();
  await page.getByRole("tab", { name: "Episode" }).click();
  const types = page.getByRole("region", { name: "Tile types" });
  await userEvent.selectOptions(types.getByLabelText("From episode"), "II");
  await userEvent.selectOptions(types.getByLabelText("Type"), String(0x51));
  // a click of our own: the work starts after the next frame
  (types.getByRole("button", { name: "Copy" }).element() as HTMLElement).click();
  expect(app.sidePanel.element.inert).toBe(true);
  app.undo();
  const select = document.querySelector<HTMLSelectElement>('select[aria-label="Episode"]');
  if (!select) throw new Error("no episode select");
  select.value = "1";
  select.dispatchEvent(new Event("change"));
  expect(select.value).toBe("0");
  await app.idle();
  expect(app.episode).toBe(0);
  expect(editor.tileTypeCopies(0)).toHaveLength(1);
  expect(editor.room(0, 43).base[0]).toBe(0x0105);
});

test("the map's thumbnails are drawn again when the episode's flags change", () => {
  app.showEpisode(0, 43);
  const editor = defined(app.editor, "editor");
  const thumbnail = (id: number) =>
    (app as unknown as { thumbnail(id: number): unknown }).thumbnail(id);
  const first = thumbnail(43);
  expect(thumbnail(43)).toBe(first);
  const cache = (app as unknown as { thumbnails: Map<number, Map<number, { key: string }>> })
    .thumbnails;
  const key = cache.get(0)?.get(43)?.key;
  editor.setEpisodeFlags(0, 43, editor.episodeFlags(0) ^ 0x20);
  thumbnail(43);
  expect(cache.get(0)?.get(43)?.key).not.toBe(key);
});
