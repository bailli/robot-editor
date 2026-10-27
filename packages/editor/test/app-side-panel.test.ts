import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { LOGIC_CELL, parseMod, readDealer } from "@robot/formats";

import { app, clickCell, game, useApp } from "./app-setup.ts";
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
const dealer = () => page.getByRole("region", { name: "Dealer" });
const price = (n: number) => dealer().getByLabelText(`Price of good ${n}`, { exact: true });

test("the tabs tell what the room has without opening them", () => {
  // episode I room 43: two actors and a RandObj call, a script, no circuit, nothing selected
  app.showEpisode(1, 43);
  expect(tab("actors")).toMatchObject({
    badge: "3",
    empty: false,
    title: "2 actors, 1 RandObj call",
  });
  expect(tab("script")).toMatchObject({ badge: "●", empty: false });
  expect(tab("script").title).toMatch(/^A script of \d+ lines$/);
  expect(tab("circuit")).toMatchObject({ badge: undefined, empty: true });
  expect(tab("record")).toMatchObject({ empty: true });
  expect(tab("episode")).toMatchObject({ badge: undefined, empty: false });
  // seven circuit nodes, none on
  app.showRoom(128);
  expect(tab("circuit")).toMatchObject({ badge: "0/7", empty: false, title: "0 of 7 nodes on" });
  // episode II room 123: robots, androids, a bomb and RandObj calls
  app.showEpisode(2, 123);
  expect(tab("actors").title).toMatch(/^\d+ actors, 3 RandObj calls$/);
  // episode III: no dealer
  app.showEpisode(3, 41);
  expect(tab("episode")).toMatchObject({ empty: true, title: "No dealer in this episode" });
});

test("the Record tab is marked while a record is selected", async () => {
  // episode II room 55: a teleporter
  app.showEpisode(2, 55);
  await clickCell(game.room(2, 55).base.findIndex((c) => (c & 0xff) === LOGIC_CELL));
  expect(tab("record").empty).toBe(false);
  expect(tab("record").title).toMatch(/^\(\d+, \d+\): /);
  app.showRoom(43);
  expect(tab("record").empty).toBe(true);
});

test("a script being edited marks its tab until applied or cancelled", async () => {
  app.showEpisode(1, 43);
  await page.getByRole("tab", { name: "Script" }).click();
  await page.getByRole("button", { name: "Edit" }).click();
  expect(tab("script").badge).toBe("●"); // nothing typed yet
  await userEvent.keyboard("x");
  expect(tab("script")).toMatchObject({ badge: "✎" });
  expect(tab("script").title).toMatch(/edited, not applied$/);
  await page.getByRole("button", { name: "Cancel" }).click();
  expect(tab("script").badge).toBe("●");
});

test("the Episode tab edits the dealer's goods, undoably; the mod keeps them", async () => {
  const original = defined(readDealer(game.image, 1));
  app.showEpisode(1, 43);
  await page.getByRole("tab", { name: "Episode" }).click();
  await expect.element(dealer().getByText("Dealers appear in rooms 18, 24, 42.")).toBeVisible();
  expect(document.querySelectorAll(".dealer-good").length).toBe(27);
  await expect.element(dealer().getByText("27 of 27")).toBeVisible();
  await expect
    .element(dealer().getByRole("button", { name: "Add the current tile" }))
    .toBeDisabled();

  // a price: one undo step; the field stays the one focused
  const field = price(1).element();
  await userEvent.fill(price(1), "99");
  await userEvent.keyboard("{Tab}");
  expect(app.editor?.dealer(1)?.goods[0]).toEqual({ tile: 0x0020, price: 99 });
  expect(price(1).element()).toBe(field);
  expect(tab("episode")).toMatchObject({ badge: "●", title: "The dealer sells 27 goods (edited)" });

  // the last good goes; the current tile replaces the first one; fewer shown
  const rows = () => document.querySelectorAll(".dealer-good");
  await dealer().getByRole("button", { name: "×" }).last().click();
  expect(rows().length).toBe(26);
  app.setTile(0x0315);
  defined(rows()[0].querySelector("canvas") ?? undefined).dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
  expect(app.editor?.dealer(1)?.goods[0]).toEqual({ tile: 0x0315, price: 99 });
  await userEvent.fill(dealer().getByLabelText("Shown at most"), "6");
  await userEvent.keyboard("{Enter}");
  expect(app.editor?.dealer(1)?.most).toBe(6);
  // room for one more now
  await dealer().getByRole("button", { name: "Add the current tile" }).click();
  expect(app.editor?.dealer(1)?.goods.at(-1)).toEqual({ tile: 0x0315, price: 10 });

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
