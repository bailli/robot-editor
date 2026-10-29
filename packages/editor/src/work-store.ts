import type { ScriptDraft } from "./script-view.ts";

/** The exe last opened, kept in the browser. */
export interface KeptExe {
  bytes: Uint8Array;
  name: string;
}

/** The work on the kept exe: enough to bring the editor back after a reload. */
export interface Work {
  /** The edits as a mod (Editor.asMod). */
  mod: string;
  /** The mod's file, once one was opened or saved. */
  modFile?: string | undefined;
  /** The mod as last opened or saved (also as an exe); none: the exe as loaded. */
  saved?: string | undefined;
  /** Changes since then. */
  dirty: boolean;
  /** Script drafts not applied, by room ("<episode> <room>"). */
  drafts: [string, ScriptDraft][];
}

const STORE = "work";
const EXE = "exe";
const WORK = "work";

/**
 * Keeps the editor's work in the browser (IndexedDB): the exe last opened and the edits
 * on it, never uploaded. Only one tab at a time edits it, the one holding the lock (Web
 * Locks; the browser lets it go when the tab closes or crashes).
 */
export class WorkStore {
  private readonly db: IDBDatabase;
  private readonly lockName: string;
  /** Lets the lock go (release). */
  private unlock: (() => void) | undefined;

  private constructor(db: IDBDatabase, lockName: string) {
    this.db = db;
    this.lockName = lockName;
  }

  /** Opens the store (the tests use names of their own). */
  static open(name = "robot-editor"): Promise<WorkStore> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        resolve(new WorkStore(request.result, name));
      };
      request.onerror = () => {
        reject(request.error ?? new Error(`cannot open ${name}`));
      };
    });
  }

  /**
   * Takes the store for this tab: false when another tab has it, unless `steal`, which
   * takes it from that tab (its `lost` is called). Browsers without Web Locks: always.
   */
  claim(steal: boolean, lost: () => void): Promise<boolean> {
    if (!("locks" in navigator)) return Promise.resolve(true);
    this.release();
    return new Promise((resolve, reject) => {
      let granted = false;
      const options: LockOptions = steal ? { steal: true } : { ifAvailable: true };
      navigator.locks
        .request(this.lockName, options, (lock) => {
          granted = lock !== null;
          resolve(granted);
          if (!lock) return undefined;
          // held as long as the page lives, unless another tab takes it
          return new Promise<void>((done) => {
            this.unlock = done;
          });
        })
        .then(undefined, (error: unknown) => {
          if (!granted) reject(error instanceof Error ? error : new Error(String(error)));
          else {
            this.unlock = undefined;
            lost();
          }
        });
    });
  }

  /** Lets the lock go, e.g. before the app is replaced (tests). */
  release(): void {
    this.unlock?.();
    this.unlock = undefined;
  }

  async exe(): Promise<KeptExe | undefined> {
    const kept = await this.get(EXE);
    return isKeptExe(kept) ? kept : undefined;
  }

  async work(): Promise<Work | undefined> {
    const kept = await this.get(WORK);
    return isWork(kept) ? kept : undefined;
  }

  /** Keeps a newly opened exe, without work on it yet. */
  keepExe(exe: KeptExe): Promise<void> {
    return this.change((store) => {
      store.put(exe, EXE);
      store.delete(WORK);
    });
  }

  keepWork(work: Work): Promise<void> {
    return this.change((store) => {
      store.put(work, WORK);
    });
  }

  /** Forgets the exe and the work on it. */
  clear(): Promise<void> {
    return this.change((store) => {
      store.clear();
    });
  }

  private get(key: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const request = this.db.transaction(STORE).objectStore(STORE).get(key);
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(request.error ?? new Error(`cannot read ${key}`));
      };
    });
  }

  private change(write: (store: IDBObjectStore) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(STORE, "readwrite");
      write(transaction.objectStore(STORE));
      transaction.oncomplete = () => {
        resolve();
      };
      transaction.onerror = transaction.onabort = () => {
        reject(transaction.error ?? new Error("the browser did not keep the work"));
      };
    });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function isKeptExe(value: unknown): value is KeptExe {
  return (
    isRecord(value) && value["bytes"] instanceof Uint8Array && typeof value["name"] === "string"
  );
}

function isWork(value: unknown): value is Work {
  const optional = (v: unknown) => v === undefined || typeof v === "string";
  return (
    isRecord(value) &&
    typeof value["mod"] === "string" &&
    optional(value["modFile"]) &&
    optional(value["saved"]) &&
    typeof value["dirty"] === "boolean" &&
    Array.isArray(value["drafts"]) &&
    value["drafts"].every(
      (d) =>
        Array.isArray(d) &&
        typeof d[0] === "string" &&
        isRecord(d[1]) &&
        typeof d[1]["draft"] === "string" &&
        typeof d[1]["base"] === "string",
    )
  );
}
