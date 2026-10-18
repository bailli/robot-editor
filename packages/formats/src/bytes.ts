/** Bounds-checked little-endian reader; parsers pass a factory for their own error type. */
export class ByteReader {
  readonly data: Uint8Array;
  readonly view: DataView;
  pos: number;
  private readonly error: (message: string) => Error;

  constructor(data: Uint8Array, error: (message: string) => Error, pos = 0) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.error = error;
    this.pos = pos;
  }

  get remaining(): number {
    return this.data.length - this.pos;
  }

  need(n: number): void {
    if (this.remaining < n) {
      throw this.error(`unexpected end of data at offset ${this.pos} (need ${n} bytes)`);
    }
  }

  u8(): number {
    this.need(1);
    return this.data[this.pos++];
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** A copy of the next n bytes. */
  bytes(n: number): Uint8Array {
    this.need(n);
    const out = this.data.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** A view of all remaining bytes. */
  rest(): Uint8Array {
    const out = this.data.subarray(this.pos);
    this.pos = this.data.length;
    return out;
  }
}
