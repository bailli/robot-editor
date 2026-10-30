import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { NO_CHANGES, emptyMod, modJson } from "@robot/formats";

import { App } from "../src/app.ts";
import { WorkStore } from "../src/work-store.ts";
import { bytes, game, roomNameField } from "./app-setup.ts";

/** Each test's own store (and lock), opened again by every "tab". */
let name: string;
const apps: App[] = [];
const stores: WorkStore[] = [];

beforeEach(() => {
  name = `robot-editor-test-${crypto.randomUUID()}`;
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
  document.body.replaceChildren();
  // a mod that cannot be restored is downloaded: a link is clicked
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(() => {
  for (const app of apps.splice(0)) app.dispose();
  for (const store of stores.splice(0)) store.release();
  for (const dialog of document.querySelectorAll("dialog")) dialog.remove();
  vi.restoreAllMocks();
});

/** A new app on the test's store, as a tab (or a reload) would make it; not started. */
async function tab(): Promise<App> {
  const store = await WorkStore.open(name);
  stores.push(store);
  const root = document.createElement("div");
  document.body.append(root);
  const app = new App(root, { store });
  apps.push(app);
  return app;
}

/** A reload: the page goes (its work written), a new one starts on the store. */
async function reload(app: App): Promise<App> {
  window.dispatchEvent(new Event("pagehide"));
  app.dispose();
  document.body.replaceChildren();
  const next = await tab();
  await next.start();
  return next;
}

/** The text of the open dialog saying another tab has the editor. */
const dialogText = () =>
  document.querySelector('dialog[aria-label="Open in another tab"][open] p')?.textContent;
const status = () => document.querySelector(".status")?.textContent;
const button = (label: string) => page.getByRole("button", { name: label, exact: true });

test("the exe and the unsaved work on it come back after a reload", async () => {
  let app = await tab();
  await app.start(() => Promise.resolve(bytes));
  expect(status()).toBe("GameOfRobot.exe loaded");
  await userEvent.fill(roomNameField(), "NEUER START");
  await userEvent.keyboard("{Enter}");
  app.sidePanel.show("script");
  await page.getByRole("region", { name: "Script" }).getByRole("button", { name: "Edit" }).click();
  await userEvent.fill(page.getByRole("textbox", { name: "Script source" }), "RoomWest = 42;");

  app = await reload(app);
  expect(app.editor?.roomName(1, 43)?.name).toBe("NEUER START");
  expect(app.editor?.dirty).toBe(true);
  expect(status()).toBe(
    "GameOfRobot.exe restored with unsaved changes and 1 script draft (undo starts here)",
  );
  expect(document.querySelector('.room-list [data-room="43"]')?.classList.contains("drafted")).toBe(
    true,
  );
  await expect.element(button("Save exe")).toBeEnabled();

  // saved: nothing unsaved after the next reload either
  app.save();
  app = await reload(app);
  expect(app.editor?.roomName(1, 43)?.name).toBe("NEUER START");
  expect(app.editor?.dirty).toBe(false);
});

test("Discard changes goes back to the mod as opened, also after a reload", async () => {
  let app = await tab();
  await app.start(() => Promise.resolve(bytes));
  const mod = {
    ...emptyMod(bytes, "test"),
    changes: {
      ...NO_CHANGES,
      rooms: [{ episode: 1, id: 45, room: { ...game.room(1, 43), id: 45 } }],
    },
  };
  app.loadMod(modJson(mod), "test.robotmod.json");
  await userEvent.fill(roomNameField(), "NEUER START");
  await userEvent.keyboard("{Enter}");

  app = await reload(app);
  expect(status()).toBe("test.robotmod.json restored with unsaved changes (undo starts here)");
  expect(app.editor?.dirty).toBe(true);
  await button("Reset…").click();
  await expect
    .poll(() => [...document.querySelectorAll("dialog[open] li")].map((li) => li.textContent))
    .toEqual(["GameOfRobot.exe", "the mod test.robotmod.json", "unsaved changes"]);
  await button("Discard changes").click();
  expect(status()).toBe("Changes discarded");
  expect(app.editor?.roomName(1, 43)?.name).toBe(game.roomName(1, 43)?.name);
  expect(app.editor?.isEdited(1, 45)).toBe(true);
  expect(app.editor?.dirty).toBe(false);
  // saving means saving the mod still
  await expect.element(button("Save mod")).toBeEnabled();
  app = await reload(app);
  expect(status()).toBe("test.robotmod.json restored");
  expect(app.editor?.isEdited(1, 45)).toBe(true);
});

test("Forget everything empties the store and the editor", async () => {
  let app = await tab();
  await app.start(() => Promise.resolve(bytes));
  await button("Reset…").click();
  await expect.element(button("Discard changes")).toBeDisabled();
  await button("Forget everything").click();
  await expect.poll(() => document.querySelector<HTMLElement>(".welcome")?.hidden).toBe(false);
  expect(app.editor).toBeUndefined();
  await expect.element(button("Save exe")).toBeDisabled();
  app = await reload(app);
  expect(app.editor).toBeUndefined();
});

test("the Console setting stays across reloads, also when everything is forgotten", async () => {
  const app = await tab();
  await app.start(() => Promise.resolve(bytes));
  const chip = page.getByRole("checkbox", { name: "Console" });
  await expect.element(chip).not.toBeChecked();
  await chip.click();
  await expect.poll(async () => (await stores.at(-1)?.settings())?.console).toBe(true);
  await reload(app);
  await expect.element(chip).toBeChecked();
  await button("Reset…").click();
  await button("Forget everything").click();
  await expect.poll(() => document.querySelector<HTMLElement>(".welcome")?.hidden).toBe(false);
  expect((await stores.at(-1)?.settings())?.console).toBe(true);
});

test("one tab at a time: another one waits, then takes the work over", async () => {
  const first = await tab();
  await first.start(() => Promise.resolve(bytes));
  await userEvent.fill(roomNameField(), "NEUER START");
  await userEvent.keyboard("{Enter}");
  // switching tabs writes the work
  window.dispatchEvent(new Event("blur"));

  const second = await tab();
  const started = second.start();
  const take = button("Open here instead");
  await expect.poll(dialogText).toBe("The editor is open in another tab, which keeps the work.");
  expect(second.editor).toBeUndefined();
  await take.click();
  await started;
  expect(second.editor?.roomName(1, 43)?.name).toBe("NEUER START");
  // the first one stops
  await expect.poll(dialogText).toBe("The editor continues in another tab, which keeps the work.");
});

test("work the editor cannot restore is downloaded, the exe opens", async () => {
  const store = await WorkStore.open(name);
  stores.push(store);
  await store.keepExe({ bytes, name: "Robot.exe" });
  await store.keepWork({ mod: "{}", dirty: true, drafts: [] });
  const app = await tab();
  await app.start();
  expect(status()).toMatch(
    /^Robot\.exe restored without the work on it \(.+\): it is downloaded as unrestored\.robotmod\.json$/,
  );
  expect(app.editor?.dirty).toBe(false);
});
