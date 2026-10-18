import { DIRECTORY_RESOURCE, PeFormatError, type PeImage, readRva } from "./pe.ts";

/**
 * Reader for the PE resource tree (type / name / language), so game data can be taken
 * straight from GameOfRobot.exe. The game's own data uses named types (CRUNCHED, SCENE,
 * SHAPES, MUSIC, PCXBITMAP) with numeric names, e.g. SCENE/1104.
 */

export interface PeResource {
  /** Numeric (see ResourceType) or named type. */
  type: number | string;
  name: number | string;
  /** Windows language id, e.g. 1031 (German), 1033 (English), 0 (neutral). */
  language: number;
  data: Uint8Array;
}

/** Standard numeric resource types (RT_*). */
export const ResourceType = {
  CURSOR: 1,
  BITMAP: 2,
  ICON: 3,
  MENU: 4,
  DIALOG: 5,
  STRING: 6,
  ACCELERATOR: 9,
  GROUP_CURSOR: 12,
  GROUP_ICON: 14,
  VERSION: 16,
} as const;

const LEVELS = 3;

export function readResources(image: PeImage): PeResource[] {
  const dir = image.dataDirectories.at(DIRECTORY_RESOURCE);
  if (!dir || dir.size === 0) return [];
  const root = readRva(image, dir.rva, dir.size);
  const view = new DataView(root.buffer, root.byteOffset, root.byteLength);

  const check = (offset: number, length: number) => {
    if (offset + length > root.length) {
      throw new PeFormatError(`resource directory entry outside the section at ${offset}`);
    }
  };
  const readName = (field: number): number | string => {
    if (!(field & 0x80000000)) return field & 0xffff;
    const offset = field & 0x7fffffff;
    check(offset, 2);
    const length = view.getUint16(offset, true);
    check(offset + 2, length * 2);
    let s = "";
    for (let i = 0; i < length; i++)
      s += String.fromCharCode(view.getUint16(offset + 2 + i * 2, true));
    return s;
  };

  const out: PeResource[] = [];
  /** Directory levels: 0 = types, 1 = names, 2 = languages (whose entries are data). */
  const walk = (offset: number, path: readonly (number | string)[]) => {
    check(offset, 16);
    const count = view.getUint16(offset + 12, true) + view.getUint16(offset + 14, true);
    check(offset + 16, count * 8);
    for (let i = 0; i < count; i++) {
      const entry = offset + 16 + i * 8;
      const key = readName(view.getUint32(entry, true));
      const target = view.getUint32(entry + 4, true);
      const isDirectory = (target & 0x80000000) !== 0;
      const isLeafLevel = path.length === LEVELS - 1;
      if (isDirectory === isLeafLevel) {
        throw new PeFormatError(`unexpected resource tree layout at level ${path.length}`);
      }
      if (isDirectory) {
        walk(target & 0x7fffffff, [...path, key]);
        continue;
      }
      check(target, 16);
      const [type = 0, name = 0] = path;
      out.push({
        type,
        name,
        language: typeof key === "number" ? key : 0,
        data: readRva(image, view.getUint32(target, true), view.getUint32(target + 4, true)),
      });
    }
  };
  walk(0, []);
  return out;
}

/** Finds a resource by type and name; with no language given, the first one found. */
export function findResource(
  resources: readonly PeResource[],
  type: number | string,
  name: number | string,
  language?: number,
): PeResource | undefined {
  return resources.find(
    (r) =>
      r.type === type && r.name === name && (language === undefined || r.language === language),
  );
}
