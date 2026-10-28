/** An element with a class and text (both optional). */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(text: string, title: string, click: () => void): HTMLButtonElement {
  const b = element("button", undefined, text);
  b.type = "button";
  b.title = title;
  b.addEventListener("click", click);
  return b;
}

export function select(label: string, options: readonly [string, string][], value: string) {
  const s = element("select", "record-field tile-type-field");
  s.setAttribute("aria-label", label);
  for (const [v, text] of options) {
    const o = element("option", undefined, text);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  return s;
}
