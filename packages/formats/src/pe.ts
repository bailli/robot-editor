/**
 * Minimal reader for 32-bit PE images (GameOfRobot.exe): headers, data directories and
 * section mapping, enough to read initialised data by virtual address.
 */

export interface PeSection {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawOffset: number;
  rawSize: number;
}

export interface PeDataDirectory {
  rva: number;
  size: number;
}

export interface PeImage {
  data: Uint8Array;
  imageBase: number;
  /** Indexed by IMAGE_DIRECTORY_ENTRY_* (e.g. 2 = resources). */
  dataDirectories: PeDataDirectory[];
  sections: PeSection[];
}

export const DIRECTORY_RESOURCE = 2;

export class PeFormatError extends Error {
  override name = "PeFormatError";
}

const PE32_MAGIC = 0x10b;

export function parsePe(data: Uint8Array): PeImage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.length < 0x40 || view.getUint16(0, true) !== 0x5a4d) {
    throw new PeFormatError("not an MZ executable");
  }
  const pe = view.getUint32(0x3c, true);
  if (pe + 24 > data.length || view.getUint32(pe, true) !== 0x00004550) {
    throw new PeFormatError("missing PE signature");
  }
  const sectionCount = view.getUint16(pe + 6, true);
  const optionalSize = view.getUint16(pe + 20, true);
  const optional = pe + 24;
  if (view.getUint16(optional, true) !== PE32_MAGIC) {
    throw new PeFormatError("not a 32-bit PE image");
  }
  const imageBase = view.getUint32(optional + 28, true);
  const directoryCount = Math.min(view.getUint32(optional + 92, true), (optionalSize - 96) / 8);
  const dataDirectories = Array.from({ length: directoryCount }, (_, i) => ({
    rva: view.getUint32(optional + 96 + i * 8, true),
    size: view.getUint32(optional + 100 + i * 8, true),
  }));
  const sections: PeSection[] = [];
  for (let i = 0; i < sectionCount; i++) {
    const h = optional + optionalSize + i * 40;
    if (h + 40 > data.length) {
      throw new PeFormatError("truncated section table");
    }
    const rawName = data.subarray(h, h + 8);
    const end = rawName.indexOf(0);
    sections.push({
      name: String.fromCharCode(...(end < 0 ? rawName : rawName.subarray(0, end))),
      virtualSize: view.getUint32(h + 8, true),
      virtualAddress: view.getUint32(h + 12, true),
      rawSize: view.getUint32(h + 16, true),
      rawOffset: view.getUint32(h + 20, true),
    });
  }
  return { data, imageBase, dataDirectories, sections };
}

/** Reads initialised bytes at a virtual address (e.g. 0x4827f0); returns a view into the image. */
export function readVa(image: PeImage, va: number, length: number): Uint8Array {
  return readRva(image, va - image.imageBase, length);
}

/** Reads initialised bytes at an address relative to the image base. */
export function readRva(image: PeImage, rva: number, length: number): Uint8Array {
  for (const s of image.sections) {
    const offset = rva - s.virtualAddress;
    if (offset >= 0 && offset + length <= s.rawSize) {
      return image.data.subarray(s.rawOffset + offset, s.rawOffset + offset + length);
    }
  }
  const va = image.imageBase + rva;
  throw new PeFormatError(`no initialised data at 0x${va.toString(16)} (+${length})`);
}
