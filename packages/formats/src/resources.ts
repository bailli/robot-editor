import {
  DIRECTORY_RESOURCE,
  PeFormatError,
  type PeImage,
  parsePe,
  readRva,
  resizeLastSection,
} from "./pe.ts";

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
  /** File offsets of the data and of its IMAGE_RESOURCE_DATA_ENTRY (for replaceResource). */
  dataOffset: number;
  entryOffset: number;
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
  const rootOffset = root.byteOffset - image.data.byteOffset;

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
      const data = readRva(image, view.getUint32(target, true), view.getUint32(target + 4, true));
      out.push({
        type,
        name,
        language: typeof key === "number" ? key : 0,
        data,
        dataOffset: data.byteOffset - image.data.byteOffset,
        entryOffset: rootOffset + target,
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

/**
 * A copy of the image bytes with a resource's data replaced. Data that fits is written in
 * place (the rest of the old space zeroed). Larger data moves to the end of the resource
 * section, which grows (see resizeLastSection; the section must be the image's last, as
 * in GameOfRobot.exe); the old space is zeroed, a resource already at the end grows in
 * place, so saving the same resource again does not pile up copies.
 */
export function replaceResource(
  image: PeImage,
  resource: PeResource,
  data: Uint8Array,
): Uint8Array {
  if (data.length <= resource.data.length) {
    const out = image.data.slice();
    writeResource(out, resource, resource.dataOffset, undefined, data);
    return out;
  }
  const dir = image.dataDirectories.at(DIRECTORY_RESOURCE);
  const section = image.sections.find(
    (s) => dir && dir.rva >= s.virtualAddress && dir.rva < s.virtualAddress + s.virtualSize,
  );
  if (!dir || !section) throw new PeFormatError("image without resource section");
  if (image.sections.some((s) => s.virtualAddress > section.virtualAddress)) {
    throw new PeFormatError(
      `cannot grow ${String(resource.name)}: ${section.name} is not the last section`,
    );
  }
  const sectionEnd = section.virtualAddress + section.virtualSize;
  const rva = section.virtualAddress + resource.dataOffset - section.rawOffset;
  const isLast = align8(rva + resource.data.length) >= sectionEnd;
  const newRva = isLast ? rva : align8(sectionEnd);
  const out = resizeLastSection(image, newRva + data.length - section.virtualAddress);
  const fileOffset = section.rawOffset + newRva - section.virtualAddress;
  writeResource(out, resource, fileOffset, newRva, data);
  if (dir.rva + dir.size >= sectionEnd) {
    const o = image.optionalHeaderOffset + 96 + DIRECTORY_RESOURCE * 8 + 4;
    new DataView(out.buffer).setUint32(o, newRva + data.length - dir.rva, true);
  }
  parsePe(out); // the headers still describe the file
  return out;
}

const align8 = (n: number) => (n + 7) & ~7;

/** Zeroes the old data, writes `data` at `fileOffset` and points the data entry to it. */
function writeResource(
  out: Uint8Array,
  resource: PeResource,
  fileOffset: number,
  rva: number | undefined,
  data: Uint8Array,
): void {
  out.fill(0, resource.dataOffset, resource.dataOffset + resource.data.length);
  out.set(data, fileOffset);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  if (rva !== undefined) view.setUint32(resource.entryOffset, rva, true);
  view.setUint32(resource.entryOffset + 4, data.length, true);
}
