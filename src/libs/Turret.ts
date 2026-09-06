import type { AmmoType } from "./types";

export class Turret {
  constructor(
    readonly direction: number,
    readonly ammoType: AmmoType,
  ) {}
}
