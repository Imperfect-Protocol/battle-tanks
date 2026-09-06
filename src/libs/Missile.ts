import { Projectile } from "./Projectile";

export class Missile extends Projectile {
  override onImpact() {
    return this.record.damage;
  }
}
