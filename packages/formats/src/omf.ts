/**
 * Reader for the 16-bit Intel OMF object files stored in SHAPES resources
 * (written by "TOM Productions Shape editor SED93", linked by the game at 0x43a050).
 *
 * Handles the record types these files use: THEADR, COMENT, LNAMES, SEGDEF, GRPDEF,
 * PUBDEF, LEDATA, FIXUPP and MODEND. FIXUPP THREAD subrecords are not supported.
 */

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

class RecordReader {
  readonly body: Uint8Array;
  readonly view: DataView;
  pos = 0;

  constructor(body: Uint8Array) {
    this.body = body;
    this.view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  }

  get done(): boolean {
    return this.pos >= this.body.length;
  }

  u8(): number {
    if (this.pos >= this.body.length) throw new OmfFormatError("record too short");
    return this.body[this.pos++];
  }

  u16(): number {
    if (this.pos + 2 > this.body.length) throw new OmfFormatError("record too short");
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  /** OMF index: one byte, or two bytes if the high bit of the first is set. */
  index(): number {
    const b = this.u8();
    return b & 0x80 ? ((b & 0x7f) << 8) | this.u8() : b;
  }

  name(): string {
    const length = this.u8();
    if (this.pos + length > this.body.length) throw new OmfFormatError("name too long");
    const s = String.fromCharCode(...this.body.subarray(this.pos, this.pos + length));
    this.pos += length;
    return s;
  }

  rest(): Uint8Array {
    const out = this.body.subarray(this.pos);
    this.pos = this.body.length;
    return out;
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
        r.u8(); // attributes
        const size = r.u16();
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
          const frameMethod = (fixData >> 4) & 7;
          const targetMethod = fixData & 3;
          if (frameMethod < 4) r.index();
          const target = r.index();
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
