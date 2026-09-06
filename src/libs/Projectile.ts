import { Vector } from "./Vector";
import type { ProjectileRecord } from "./types";

export class Projectile {
  readonly position: Vector;
  readonly velocity: Vector;

  constructor(readonly record: ProjectileRecord) {
    this.position = Vector.fromRecord(record.position);
    this.velocity = Vector.fromRecord(record.velocity);
  }

  onImpact() {
    return this.record.damage;
  }
}
