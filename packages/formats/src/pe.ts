/**
 * Minimal reader for 32-bit PE images (GameOfRobot.exe): headers and section mapping,
 * enough to read initialised data by virtual address.
 */

export interface PeSection {
  name: string;
  virtualAddress: number;
  virtualSize: number;
  rawOffset: number;
  rawSize: number;
}

export interface PeImage {
  data: Uint8Array;
  imageBase: number;
  sections: PeSection[];
}

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
  return { data, imageBase, sections };
}

/** Reads initialised bytes at a virtual address (e.g. 0x4827f0); returns a view into the image. */
export function readVa(image: PeImage, va: number, length: number): Uint8Array {
  const rva = va - image.imageBase;
  for (const s of image.sections) {
    const offset = rva - s.virtualAddress;
    if (offset >= 0 && offset + length <= s.rawSize) {
      return image.data.subarray(s.rawOffset + offset, s.rawOffset + offset + length);
    }
  }
  throw new PeFormatError(`no initialised data at 0x${va.toString(16)} (+${length})`);
}
