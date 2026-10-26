/**
 * Brings `target`'s children in line with `children` in place, for views that rebuild
 * themselves after each edit: nodes that match by position (same tag and `data-key`;
 * canvases never) are kept and updated, so focus and the Tab order survive the edit;
 * the others are replaced. A kept element keeps its own listeners, not the new one's:
 * they must not depend on the state the element was built with.
 */
export function patchChildren(target: Node, children: readonly Node[]): void {
  const old = [...target.childNodes];
  children.forEach((node, i) => {
    const before = old.at(i);
    if (!before) target.appendChild(node);
    else if (matches(before, node)) patchNode(before, node);
    else target.replaceChild(node, before);
  });
  for (const extra of old.slice(children.length)) extra.remove();
}

function matches(a: Node, b: Node): boolean {
  if (a.nodeName !== b.nodeName || a instanceof HTMLCanvasElement) return false;
  return (
    !(a instanceof HTMLElement && b instanceof HTMLElement) || a.dataset["key"] === b.dataset["key"]
  );
}

function patchNode(a: Node, b: Node): void {
  if (!(a instanceof Element && b instanceof Element)) {
    if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue;
    return;
  }
  for (const { name } of [...a.attributes]) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of b.attributes)
    if (a.getAttribute(name) !== value) a.setAttribute(name, value);
  // read before its options move over: b then falls back to its first one
  const selected = b instanceof HTMLSelectElement ? b.value : undefined;
  patchChildren(a, [...b.childNodes]);
  // what the attributes do not carry
  if (a instanceof HTMLInputElement && b instanceof HTMLInputElement) {
    if (a.value !== b.value) a.value = b.value;
    a.checked = b.checked;
  } else if (a instanceof HTMLSelectElement && selected !== undefined) a.value = selected;
}
