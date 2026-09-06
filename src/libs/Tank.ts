import { Turret } from "./Turret";
import { Vector } from "./Vector";
import type { LegacyDirection, TankRecord } from "./types";

const legacyDirectionDegrees: Record<LegacyDirection, number> = {
  east: 0,
  south: 90,
  west: 180,
  north: 270,
};

export class Tank {
  readonly position: Vector;
  readonly velocity: Vector;
  readonly turret: Turret;

  constructor(readonly record: TankRecord) {
    this.position = Vector.fromRecord(record.position);
    this.velocity = Vector.fromRecord(record.velocity);
    this.turret = new Turret(angleFromDirection(record.turretDirection), record.ammoType);
  }

  get id() {
    return this.record._id;
  }

  get playerId() {
    return this.record.playerId;
  }

  get health() {
    return this.record.health;
  }

  get hullDirection() {
    return this.record.hullDirection;
  }

  get alive() {
    return this.health > 0;
  }
}

function angleFromDirection(direction: number | LegacyDirection) {
  if (typeof direction === "number") {
    return direction;
  }

  return legacyDirectionDegrees[direction];
}
