export type VectorRecord = {
  x: number;
  y: number;
};

export type AmmoType = "missile";
export type LegacyDirection = "north" | "east" | "south" | "west";

export type TankSpecRecord = {
  hullColor: string;
  turretOffset: number;
  cannonLength: number;
  turretSize: number;
};

export type PlayerRecord = {
  _id: string;
  userId?: string;
  commanderId?: string;
  name: string;
  score: number;
  slot: "alpha" | "bravo";
};

export type BoardRecord = {
  _id: string;
  code: string;
  name: string;
  size: number;
  walls: VectorRecord[];
  spawnPoints: VectorRecord[];
};

export type TankRecord = {
  _id: string;
  playerId: string;
  position: VectorRecord;
  velocity: VectorRecord;
  speed?: number;
  moveRemaining?: number;
  activeMoveCommand?: string;
  hullDirection: number | LegacyDirection;
  turretDirection: number | LegacyDirection;
  turretLocked?: boolean;
  launchAngle?: number;
  cannonPower?: number;
  lastFirePower?: number;
  tankSpec?: TankSpecRecord;
  ammoType: AmmoType;
  health: number;
  updatedAt: number;
};

export type ProjectileRecord = {
  _id: string;
  ownerTankId: string;
  position: VectorRecord;
  velocity: VectorRecord;
  damage: number;
  rangeRemaining?: number;
  height?: number;
  verticalVelocity?: number;
  launchPower?: number;
  launchAngle?: number;
  explosionEndsAt?: number;
  status: "active" | "exploding" | "spent";
};

export type OrderRecord = {
  _id: string;
  playerId: string;
  tankId: string;
  commands: string[];
  cursor: number;
  status: "queued" | "running" | "complete";
};
