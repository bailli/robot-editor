import { expect, test } from "vitest";
import { page, userEvent } from "vitest/browser";

import { PACKAGE_CLASS, textsId } from "@robot/formats";

import { app, game, useApp } from "./app-setup.ts";
import { defined } from "./game.ts";

useApp();

const status = () => document.querySelector(".status")?.textContent;
const tiles = () => page.getByRole("tabpanel", { name: "Tiles" });

/** Types a value into a field and leaves it with Enter. */
async function enter(field: ReturnType<typeof page.getByRole>, value: string) {
  await userEvent.fill(field, value);
  await userEvent.keyboard("{Enter}");
}

test("an expert field's points are the tile's state × 10,000", async () => {
  app.setTile(0x0c32);
  const points = tiles().getByRole("spinbutton", { name: "Points" });
  await expect.element(points).toHaveValue(120000);
  await enter(points, "50000");
  expect(app.tile).toBe(0x0532);
  // points between the steps are not taken
  await enter(points, "55000");
  expect(app.tile).toBe(0x0532);
  expect(status()).toMatch(/^Not taken: points go in steps of 10000/);
  await expect.element(points).toHaveValue(50000);
});

test("a letter's character is its state", async () => {
  app.setTile(0x4125);
  const char = tiles().getByRole("textbox", { name: "Character" });
  await expect.element(char).toHaveValue("A");
  await enter(char, "q"); // the game's letters are upper case
  expect(app.tile).toBe(0x5125);
});

test("a note's message and whether it is read on the spot", async () => {
  app.setTile(0x013a); // message 801, picked up
  const message = tiles().getByRole("spinbutton", { name: "Message" });
  await expect.element(message).toHaveValue(801);
  const text = defined(defined(app.editor).textEntry(textsId(1), 801))[0];
  expect(text).toBeDefined();
  await expect.element(tiles().getByRole("button", { name: "Write text 801" })).toBeVisible();
  await tiles().getByRole("checkbox", { name: "Read when stepped on" }).click();
  expect(app.tile).toBe(0x813a);
  await enter(message, "812");
  expect(app.tile).toBe(0x8c3a);
  await enter(message, "928");
  expect(app.tile).toBe(0x8c3a);
  expect(status()).toMatch(/^Not taken: a note shows a message from 800 to 927/);
});

test("the current tile's preview draws what a package holds on it", () => {
  app.showEpisode(2, 1);
  const held = () => document.querySelectorAll(".tile-preview canvas.held");
  app.setTile(0x135e);
  expect(held()).toHaveLength(1);
  app.setTile(0x005e); // nothing inside
  expect(held()).toHaveLength(0);
  app.setTile(0x0013);
  expect(held()).toHaveLength(0);
});

test("other tiles have no data", async () => {
  app.setTile(0x0000);
  await expect.element(tiles().getByRole("spinbutton")).not.toBeInTheDocument();
});

test("the selected cell's data is changed in the room, as one edit", async () => {
  app.showEpisode(2, 1);
  const { rooms, classes } = game.episode(2);
  const isPackage = (c: number) => classes.classes.get(c & 0xff)?.id === PACKAGE_CLASS;
  const room = defined(rooms.find((r) => r.id !== 1 && r.base.some(isPackage)));
  const index = room.base.findIndex(isPackage);
  const before = defined(room.base[index]);
  app.showRoom(room.id);
  await page.getByRole("tab", { name: "Record" }).click();
  app.select(index);
  const section = page.getByRole("region", { name: "Data of the cell" });
  const holds = section.getByRole("combobox", { name: "Package contents" });
  await expect.element(holds).toHaveValue(String(before >> 8));
  const type = before >> 8 === 0x0a ? 0x0b : 0x0a;
  await userEvent.selectOptions(holds, String(type));
  const cell = () => defined(app.editor).room(2, room.id).base[index];
  expect(cell()).toBe((before & 0xff) | (type << 8));
  app.undo();
  expect(cell()).toBe(before);
  await expect.element(holds).toHaveValue(String(before >> 8));
});

test("a plain cell has no data section", async () => {
  await page.getByRole("tab", { name: "Record" }).click();
  app.select(0);
  await expect
    .element(page.getByRole("region", { name: "Data of the cell" }))
    .not.toBeInTheDocument();
});
