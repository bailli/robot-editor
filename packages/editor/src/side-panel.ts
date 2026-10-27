/** A panel of the side column: its name, its tab's label and its content. */
export interface SideTab {
  name: string;
  label: string;
  content: HTMLElement;
}

/** What a tab's button tells about its content without opening it. */
export interface TabState {
  /** A short text after the label: a count, a mark. */
  badge?: string;
  /** Nothing there for the shown room: the label is dimmed. */
  empty?: boolean;
  /** Something to look at (unapplied or edited): the badge in the edited colour. */
  note?: boolean;
  /** What the badge stands for, in the button's tooltip. */
  title?: string;
}

const WIDTH_KEY = "robot-editor-side-width";
const MIN_WIDTH = 240;
const MAX_WIDTH = 900;

/**
 * The column right of the room: tabs (tiles, the selected cell's record, the actors, the
 * script, the room's settings), one shown at a time and scrolling on its own, so nothing pushes the room out
 * of the window. Its left edge can be dragged; the width is remembered in this browser.
 */
export class SidePanel {
  readonly element = document.createElement("aside");
  private readonly bar = document.createElement("div");
  private readonly tabs = new Map<
    string,
    { button: HTMLButtonElement; badge: HTMLElement; panel: HTMLElement }
  >();
  private current = "";

  /** `resize` gets the new width while the edge is dragged. */
  constructor(tabs: readonly SideTab[], resize: (width: number) => void) {
    this.element.className = "side-panel";
    this.bar.className = "side-tabs";
    this.bar.setAttribute("role", "tablist");
    const handle = document.createElement("div");
    handle.className = "side-handle";
    handle.title = "Drag to make the column wider or narrower";
    this.element.append(handle, this.bar);
    for (const tab of tabs) {
      const button = document.createElement("button");
      const label = document.createElement("span");
      label.textContent = tab.label;
      // the tab's name stays its label; the tooltip says what the badge stands for
      const badge = document.createElement("span");
      badge.className = "tab-badge";
      badge.setAttribute("aria-hidden", "true");
      badge.hidden = true;
      button.append(label, badge);
      button.setAttribute("role", "tab");
      button.title = `key ${this.tabs.size + 1}`;
      button.addEventListener("click", () => {
        this.show(tab.name);
      });
      const panel = document.createElement("div");
      panel.className = `side-content side-${tab.name}`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-label", tab.label);
      panel.append(tab.content);
      this.tabs.set(tab.name, { button, badge, panel });
      this.bar.append(button);
      this.element.append(panel);
    }
    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const right = this.element.getBoundingClientRect().right;
      const move = (e: MouseEvent) => {
        const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, right - e.clientX));
        resize(width);
        try {
          localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
        } catch {
          // storage unavailable: the width just is not remembered
        }
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    });
    const first = tabs.at(0);
    if (first) this.show(first.name);
  }

  /** The width remembered from an earlier drag, if any. */
  static savedWidth(): number | undefined {
    try {
      const width = Number(localStorage.getItem(WIDTH_KEY));
      return width >= MIN_WIDTH && width <= MAX_WIDTH ? width : undefined;
    } catch {
      return undefined;
    }
  }

  /** Puts elements above the tabs, always visible (e.g. the tool settings). */
  setHeader(...elements: HTMLElement[]): void {
    const header = document.createElement("div");
    header.className = "side-header";
    header.append(...elements);
    this.bar.before(header);
  }

  /** Marks a tab's button: a badge, dimmed when empty (see TabState). */
  setState(name: string, state: TabState): void {
    const tab = this.tabs.get(name);
    if (!tab) return;
    tab.badge.textContent = state.badge ?? "";
    tab.badge.hidden = state.badge === undefined;
    tab.badge.classList.toggle("note", state.note === true);
    tab.button.classList.toggle("empty", state.empty === true);
    if (state.title) tab.button.setAttribute("aria-description", state.title);
    else tab.button.removeAttribute("aria-description");
    tab.button.title = [state.title, `key ${this.names.indexOf(name) + 1}`]
      .filter(Boolean)
      .join(" · ");
  }

  /** The state a tab's button shows (setState). */
  state(name: string): { badge: string | undefined; empty: boolean; title: string } {
    const tab = this.tabs.get(name);
    return {
      badge: tab && !tab.badge.hidden ? tab.badge.textContent : undefined,
      empty: tab?.button.classList.contains("empty") ?? false,
      title: tab?.button.getAttribute("aria-description") ?? "",
    };
  }

  /** The tabs' names in their order. */
  get names(): string[] {
    return [...this.tabs.keys()];
  }

  get shown(): string {
    return this.current;
  }

  show(name: string): void {
    if (!this.tabs.has(name)) return;
    this.current = name;
    for (const [n, { button, panel }] of this.tabs) {
      button.setAttribute("aria-selected", String(n === name));
      button.classList.toggle("selected", n === name);
      panel.hidden = n !== name;
    }
  }
}
