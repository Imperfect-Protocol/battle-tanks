import type { VectorRecord } from "./types";

export class Vector {
  constructor(
    readonly x: number,
    readonly y: number,
  ) {}

  add(other: Vector) {
    return new Vector(this.x + other.x, this.y + other.y);
  }

  equals(other: Vector) {
    return this.x === other.x && this.y === other.y;
  }

  toRecord(): VectorRecord {
    return { x: this.x, y: this.y };
  }

  static fromRecord(record: VectorRecord) {
    return new Vector(record.x, record.y);
  }
}
