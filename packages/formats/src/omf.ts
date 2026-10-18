/**
 * Reader for the 16-bit Intel OMF object files stored in SHAPES resources
 * (written by "TOM Productions Shape editor SED93", linked by the game at 0x43a050).
 *
 * Handles the record types these files use: THEADR, COMENT, LNAMES, SEGDEF, GRPDEF,
 * PUBDEF, LEDATA, FIXUPP and MODEND. Threads (FIXUPP THREAD subrecords and fixups that
 * refer to them) are not supported and raise OmfFormatError.
 */
import { ByteReader } from "./bytes.ts";

export interface OmfSegment {
  name: string;
  data: Uint8Array;
}

export interface OmfPublic {
  name: string;
  /** Segment index into OmfModule.segments (1-based as in OMF; 0 = absolute). */
  segment: number;
  offset: number;
}

export interface OmfFixup {
  /** Segment and offset of the patched location. */
  segment: number;
  offset: number;
  /** Location type: 1 = 16-bit offset, 3 = 32-bit far pointer, ... */
  location: number;
  frameMethod: number;
  targetMethod: number;
  /** Target index; for target method 0 a segment index. */
  target: number;
  displacement: number;
}

export interface OmfModule {
  name: string;
  /** Index 0 is unused so that OMF segment indices can be used directly. */
  segments: (OmfSegment | undefined)[];
  publics: OmfPublic[];
  fixups: OmfFixup[];
}

export class OmfFormatError extends Error {
  override name = "OmfFormatError";
}

const THEADR = 0x80;
const PUBDEF = 0x90;
const LNAMES = 0x96;
const SEGDEF = 0x98;
const FIXUPP = 0x9c;
const LEDATA = 0xa0;

class RecordReader extends ByteReader {
  constructor(body: Uint8Array) {
    super(body, (message) => new OmfFormatError(`record too short: ${message}`));
  }

  get done(): boolean {
    return this.remaining === 0;
  }

  /** OMF index: one byte, or two bytes if the high bit of the first is set. */
  index(): number {
    const b = this.u8();
    return b & 0x80 ? ((b & 0x7f) << 8) | this.u8() : b;
  }

  name(): string {
    const length = this.u8();
    this.need(length);
    const s = String.fromCharCode(...this.data.subarray(this.pos, this.pos + length));
    this.pos += length;
    return s;
  }
}

export function parseOmf(data: Uint8Array): OmfModule {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const module: OmfModule = { name: "", segments: [undefined], publics: [], fixups: [] };
  const lnames: string[] = [""];
  let lastData: { segment: number; offset: number } | undefined;

  let pos = 0;
  while (pos < data.length) {
    if (pos + 3 > data.length) throw new OmfFormatError(`truncated record at ${pos}`);
    const type = data[pos];
    const length = view.getUint16(pos + 1, true);
    if (length < 1 || pos + 3 + length > data.length) {
      throw new OmfFormatError(`bad record length at ${pos}`);
    }
    const r = new RecordReader(data.subarray(pos + 3, pos + 2 + length)); // without checksum
    pos += 3 + length;

    switch (type) {
      case THEADR:
        module.name = r.name();
        break;
      case LNAMES:
        while (!r.done) lnames.push(r.name());
        break;
      case SEGDEF: {
        const acbp = r.u8();
        if (acbp >> 5 === 0) {
          r.u16(); // absolute segment: frame number
          r.u8(); // and offset
        }
        const length = r.u16();
        const size = acbp & 0x02 && length === 0 ? 0x10000 : length; // "big" bit: 64 KiB
        const name = lnames[r.index()] ?? "";
        module.segments.push({ name, data: new Uint8Array(size) });
        break;
      }
      case PUBDEF: {
        r.index(); // group
        const segment = r.index();
        if (segment === 0) r.u16(); // frame number
        while (!r.done) {
          const name = r.name();
          const offset = r.u16();
          r.index(); // type
          module.publics.push({ name, segment, offset });
        }
        break;
      }
      case LEDATA: {
        const segment = r.index();
        const offset = r.u16();
        const target = module.segments[segment];
        const chunk = r.rest();
        if (!target || offset + chunk.length > target.data.length) {
          throw new OmfFormatError(`LEDATA outside segment ${segment}`);
        }
        target.data.set(chunk, offset);
        lastData = { segment, offset };
        break;
      }
      case FIXUPP:
        while (!r.done) {
          const hi = r.u8();
          if (!(hi & 0x80)) throw new OmfFormatError("FIXUPP THREAD subrecords are not supported");
          if (!lastData) throw new OmfFormatError("FIXUPP without preceding LEDATA");
          const locat = (hi << 8) | r.u8();
          const fixData = r.u8();
          if (fixData & 0x88)
            throw new OmfFormatError("fixups referring to threads are not supported");
          const frameMethod = (fixData >> 4) & 7;
          const targetMethod = fixData & 3;
          if (frameMethod < 3) r.index();
          else if (frameMethod === 3) r.u16(); // frame number
          const target = targetMethod === 3 ? r.u16() : r.index();
          const displacement = fixData & 4 ? 0 : r.u16();
          module.fixups.push({
            segment: lastData.segment,
            offset: lastData.offset + (locat & 0x3ff),
            location: (locat >> 10) & 0xf,
            frameMethod,
            targetMethod,
            target,
            displacement,
          });
        }
        break;
      default:
        break; // COMENT, GRPDEF, MODEND and others carry nothing we need
    }
  }
  return module;
}
