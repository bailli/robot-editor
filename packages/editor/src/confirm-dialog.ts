export interface ConfirmOptions {
  /** The confirming button's label, e.g. "Delete room". */
  action: string;
  /** The action destroys something: the button is red and Cancel has the focus. */
  danger?: boolean;
}

/**
 * Asks a question in a dialog of the editor's own (instead of window.confirm, whose
 * buttons the browser orders and styles): Cancel on the left, the action on the right, as
 * in every dialog of the editor. Escape and Cancel say no.
 */
export function confirmDialog(question: string, options: ConfirmOptions): Promise<boolean> {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("aria-label", options.action);
  const form = document.createElement("form");
  form.method = "dialog";
  const lines = question.split("\n").map((line) => {
    const p = document.createElement("p");
    p.textContent = line;
    return p;
  });
  const cancel = document.createElement("button");
  cancel.value = "cancel";
  cancel.textContent = "Cancel";
  const confirm = document.createElement("button");
  confirm.value = "confirm";
  confirm.textContent = options.action;
  confirm.className = options.danger ? "primary danger" : "primary";
  const buttons = document.createElement("div");
  buttons.className = "dialog-buttons";
  buttons.append(cancel, confirm);
  form.append(...lines, buttons);
  dialog.append(form);
  document.body.append(dialog);
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "confirm");
      dialog.remove();
    });
    dialog.showModal();
    (options.danger ? cancel : confirm).focus();
  });
}
