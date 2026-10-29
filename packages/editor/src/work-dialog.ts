import { element } from "./dom.ts";

/** What the Reset dialog does: drop the unsaved changes, or forget the exe too. */
export type Reset = "discard" | "forget";

/**
 * Says what the editor keeps in the browser (`kept`, one line each) and offers to discard
 * the unsaved changes (when `changes`) or to forget everything; Escape and Cancel do
 * nothing. Cancel has the focus, both actions destroy something.
 */
export function resetDialog(kept: readonly string[], changes: boolean): Promise<Reset | undefined> {
  const dialog = element("dialog", "confirm-dialog");
  dialog.setAttribute("aria-label", "Reset");
  const form = element("form");
  form.method = "dialog";
  const list = element("ul");
  list.append(...kept.map((line) => element("li", undefined, line)));
  const cancel = element("button", undefined, "Cancel");
  cancel.value = "cancel";
  const discard = element("button", "danger", "Discard changes");
  discard.value = "discard";
  discard.disabled = !changes;
  discard.title = "Back to the exe as opened, or the mod as last opened or saved";
  const forget = element("button", "primary danger", "Forget everything");
  forget.value = "forget";
  forget.title = "Forget the exe and the work on it; the editor starts empty";
  const buttons = element("div", "dialog-buttons");
  buttons.append(cancel, discard, forget);
  form.append(element("p", undefined, "Kept in this browser:"), list, buttons);
  dialog.append(form);
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      const value = dialog.returnValue;
      resolve(value === "discard" || value === "forget" ? value : undefined);
      dialog.remove();
    });
    dialog.showModal();
    cancel.focus();
  });
}

/**
 * Says that another tab edits the work (`text`) until "Open here instead" is clicked;
 * it cannot be closed otherwise. Resolves then.
 */
export function elsewhereDialog(text: string): Promise<void> {
  const dialog = element("dialog", "confirm-dialog");
  dialog.setAttribute("aria-label", "Open in another tab");
  const form = element("form");
  form.method = "dialog";
  const take = element("button", "primary", "Open here instead");
  take.value = "take";
  take.title = "Edit here; the other tab stops";
  const buttons = element("div", "dialog-buttons");
  buttons.append(take);
  form.append(element("p", undefined, text), buttons);
  dialog.append(form);
  document.body.append(dialog);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
  });
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      // the browser may close it anyway (a second Escape): it comes back
      if (dialog.returnValue !== "take") {
        dialog.showModal();
        return;
      }
      dialog.remove();
      resolve();
    });
    dialog.showModal();
    take.focus();
  });
}
