/**
 * Reader and writer for the 16-bit Intel OMF object files stored in SHAPES resources
 * (written by "TOM Productions Shape editor SED93", linked by the game at 0x43a050).
 *
 * Handles the record types these files use: THEADR, COMENT, LNAMES, SEGDEF, GRPDEF,
 * PUBDEF, LEDATA, FIXUPP and MODEND. Threads (FIXUPP THREAD subrecords and fixups that
 * refer to them) are not supported and raise OmfFormatError.
 *
 * writeOmf writes a module the way SED93 does: THEADR, the COMENT records, one LNAMES,
 * the SEGDEFs, GRPDEFs, one PUBDEF per public, then each data block as an LEDATA
 * followed by a FIXUPP with the fixups inside it, and MODEND; every record with its
 * checksum. A displacement is written only when it is not 0 (SED93 never writes one).
 * The originals come out byte for byte (test).
 */
import { ByteReader } from "./bytes.ts";

export interface OmfSegment {
  name: string;
  data: Uint8Array;
  /** SEGDEF's ACBP byte: alignment (bits 5-7), combination, big (bit 1), page. */
  acbp: number;
  /** Indices into OmfModule.lnames of the segment's name, class and overlay name. */
  nameIndex: number;
  classIndex: number;
  overlayIndex: number;
  /** Absolute segments (alignment 0): frame number and offset. */
  frame?: number;
  frameOffset?: number;
}

export interface OmfGroup {
  /** Index into OmfModule.lnames. */
  nameIndex: number;
  /** Segment indices. */
  segments: number[];
}

export interface OmfPublic {
  name: string;
  /** Segment index into OmfModule.segments (1-based as in OMF; 0 = absolute). */
  segment: number;
  offset: number;
  /** Group index into OmfModule.groups (0 = none). */
  group: number;
  /** Type index (0 = none). */
  type: number;
}

export interface OmfFixup {
  /** Segment and offset of the patched location. */
  segment: number;
  offset: number;
  /** Location type: 1 = 16-bit offset, 3 = 32-bit far pointer, ... */
  location: number;
  /** M bit: relative to the segment (true) or to the location (false). */
  segmentRelative: boolean;
  frameMethod: number;
  /** Frame index (frame methods 0-2) or frame number (3); 0 otherwise. */
  frame: number;
  targetMethod: number;
  /** Target index; for target method 0 a segment index. */
  target: number;
  displacement: number;
}

/** Where one LEDATA record put its bytes. */
export interface OmfBlock {
  segment: number;
  offset: number;
  length: number;
}

export interface OmfModule {
  name: string;
  /** The COMENT records' bodies. */
  comments: Uint8Array[];
  /** LNAMES; index 0 is the unused "" so that OMF name indices can be used directly. */
  lnames: string[];
  /** Index 0 is unused so that OMF segment indices can be used directly. */
  segments: (OmfSegment | undefined)[];
  /** Index 0 is unused, as with segments. */
  groups: (OmfGroup | undefined)[];
  publics: OmfPublic[];
  /** The LEDATA records in file order; FIXUPP records follow the block they patch. */
  blocks: OmfBlock[];
  fixups: OmfFixup[];
}

export class OmfFormatError extends Error {
  override name = "OmfFormatError";
}

const THEADR = 0x80;
const COMENT = 0x88;
const MODEND = 0x8a;
const PUBDEF = 0x90;
const LNAMES = 0x96;
const SEGDEF = 0x98;
const GRPDEF = 0x9a;
const FIXUPP = 0x9c;
const LEDATA = 0xa0;
/** The most bytes one LEDATA record may carry, and the reach of a fixup's offset. */
export const MAX_LEDATA = 1024;

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
  const lnames: string[] = [""];
  const module: OmfModule = {
    name: "",
    comments: [],
    lnames,
    segments: [undefined],
    groups: [undefined],
    publics: [],
    blocks: [],
    fixups: [],
  };
  let lastData: OmfBlock | undefined;

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
      case COMENT:
        module.comments.push(r.rest().slice());
        break;
      case LNAMES:
        while (!r.done) lnames.push(r.name());
        break;
      case SEGDEF: {
        const acbp = r.u8();
        const absolute = acbp >> 5 === 0 ? { frame: r.u16(), frameOffset: r.u8() } : {};
        const length = r.u16();
        const size = acbp & 0x02 && length === 0 ? 0x10000 : length; // "big" bit: 64 KiB
        const nameIndex = r.index();
        const classIndex = r.index();
        const overlayIndex = r.index();
        module.segments.push({
          name: lnames[nameIndex] ?? "",
          data: new Uint8Array(size),
          acbp,
          nameIndex,
          classIndex,
          overlayIndex,
          ...absolute,
        });
        break;
      }
      case GRPDEF: {
        const nameIndex = r.index();
        const segments: number[] = [];
        while (!r.done) {
          if (r.u8() !== 0xff)
            throw new OmfFormatError("GRPDEF: only segment members are supported");
          segments.push(r.index());
        }
        module.groups.push({ nameIndex, segments });
        break;
      }
      case PUBDEF: {
        const group = r.index();
        const segment = r.index();
        if (segment === 0) throw new OmfFormatError("PUBDEF: absolute publics are not supported");
        while (!r.done) {
          const name = r.name();
          const offset = r.u16();
          const type = r.index();
          module.publics.push({ name, segment, offset, group, type });
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
        lastData = { segment, offset, length: chunk.length };
        module.blocks.push(lastData);
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
          const frame = frameMethod < 3 ? r.index() : frameMethod === 3 ? r.u16() : 0;
          const target = targetMethod === 3 ? r.u16() : r.index();
          const displacement = fixData & 4 ? 0 : r.u16();
          module.fixups.push({
            segment: lastData.segment,
            offset: lastData.offset + (locat & 0x3ff),
            location: (locat >> 10) & 0xf,
            segmentRelative: (locat & 0x4000) !== 0,
            frameMethod,
            frame,
            targetMethod,
            target,
            displacement,
          });
        }
        break;
      default:
        break; // MODEND and others carry nothing we need
    }
  }
  return module;
}

/** Bytes of one record: type, length, body, checksum (all bytes sum to 0). */
function record(type: number, body: readonly number[] | Uint8Array): number[] {
  const length = body.length + 1;
  if (length > 0xffff) throw new OmfFormatError(`record of ${body.length} bytes is too long`);
  const bytes = [type, length & 0xff, length >> 8, ...body];
  return [...bytes, -bytes.reduce((sum, b) => sum + b, 0) & 0xff];
}

const u16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const index = (i: number) => (i < 0x80 ? [i] : [0x80 | (i >> 8), i & 0xff]);
const name = (s: string) => {
  if (s.length > 0xff) throw new OmfFormatError(`name too long: ${s}`);
  return [s.length, ...Array.from(s, (c) => c.charCodeAt(0) & 0xff)];
};

function fixupBytes(f: OmfFixup, blockOffset: number): number[] {
  const at = f.offset - blockOffset;
  const locat = 0x8000 | (f.segmentRelative ? 0x4000 : 0) | (f.location << 10) | at;
  const fixData = (f.frameMethod << 4) | (f.displacement ? 0 : 4) | f.targetMethod;
  const frame = f.frameMethod < 3 ? index(f.frame) : f.frameMethod === 3 ? u16(f.frame) : [];
  return [
    locat >> 8,
    locat & 0xff,
    fixData,
    ...frame,
    ...(f.targetMethod === 3 ? u16(f.target) : index(f.target)),
    ...(f.displacement ? u16(f.displacement) : []),
  ];
}

/**
 * The module as an OMF object file (see the module comment). Every fixup must lie in a
 * block of its segment; it is written after the first such block.
 */
export function writeOmf(module: OmfModule): Uint8Array {
  const out: number[] = [...record(THEADR, name(module.name))];
  for (const comment of module.comments) out.push(...record(COMENT, comment));
  out.push(...record(LNAMES, module.lnames.slice(1).flatMap(name)));
  for (const segment of module.segments.slice(1)) {
    if (!segment) throw new OmfFormatError("missing segment definition");
    const size = segment.data.length;
    const big = size === 0x10000;
    if (size > 0x10000 || big !== ((segment.acbp & 0x02) !== 0)) {
      throw new OmfFormatError(`segment ${segment.name}: ${size} bytes do not fit its ACBP`);
    }
    out.push(
      ...record(SEGDEF, [
        segment.acbp,
        ...(segment.acbp >> 5 === 0 ? [...u16(segment.frame ?? 0), segment.frameOffset ?? 0] : []),
        ...u16(big ? 0 : size),
        ...index(segment.nameIndex),
        ...index(segment.classIndex),
        ...index(segment.overlayIndex),
      ]),
    );
  }
  for (const group of module.groups.slice(1)) {
    if (!group) throw new OmfFormatError("missing group definition");
    out.push(
      ...record(GRPDEF, [
        ...index(group.nameIndex),
        ...group.segments.flatMap((s) => [0xff, ...index(s)]),
      ]),
    );
  }
  for (const p of module.publics) {
    out.push(
      ...record(PUBDEF, [
        ...index(p.group),
        ...index(p.segment),
        ...name(p.name),
        ...u16(p.offset),
        ...index(p.type),
      ]),
    );
  }
  const written = new Set<OmfFixup>();
  for (const block of module.blocks) {
    const data = module.segments[block.segment]?.data;
    if (!data || block.length > MAX_LEDATA || block.offset + block.length > data.length) {
      throw new OmfFormatError(`block outside segment ${block.segment} or too long`);
    }
    out.push(
      ...record(LEDATA, [
        ...index(block.segment),
        ...u16(block.offset),
        ...data.subarray(block.offset, block.offset + block.length),
      ]),
    );
    const inside = module.fixups.filter(
      (f) =>
        !written.has(f) &&
        f.segment === block.segment &&
        f.offset >= block.offset &&
        f.offset < block.offset + block.length,
    );
    if (inside.length === 0) continue;
    for (const f of inside) written.add(f);
    out.push(
      ...record(
        FIXUPP,
        inside.flatMap((f) => fixupBytes(f, block.offset)),
      ),
    );
  }
  if (written.size !== module.fixups.length) {
    throw new OmfFormatError("a fixup lies outside every data block");
  }
  out.push(...record(MODEND, [0]));
  return Uint8Array.from(out);
}
