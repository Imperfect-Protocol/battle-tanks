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
  lastTickAt?: number;
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
  ownerPlayerId?: string;
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
  updatedAt: number;
};

export type WorldEventRecord = {
  _id: string;
  matchId: string;
  sourcePlayerId: string;
  sourceTankId: string;
  clientEventId?: string;
  targetTankId?: string;
  projectileId?: string;
  type: "explosion" | "tankCollision";
  position: VectorRecord;
  normal?: VectorRecord;
  radius?: number;
  damage: number;
  impactSpeed?: number;
  penetration?: number;
  createdAt: number;
  expiresAt: number;
};

export type OrderRecord = {
  _id: string;
  playerId: string;
  tankId: string;
  queueType?: "move" | "bearing" | "cannon";
  commands: string[];
  cursor: number;
  status: "queued" | "running" | "complete";
};

export type PlayerCommandRecord = {
  _id: string;
  matchId: string;
  playerId: string;
  commanderId?: string;
  clientCommandId?: string;
  queueType?: "move" | "bearing" | "cannon";
  commands: string[];
  status?: "queued" | "ready" | "running" | "complete";
  completedAt?: number;
  createdAt: number;
};

export type CommandTimelinePointRecord = {
  at: number;
  position?: VectorRecord;
  velocity?: VectorRecord;
  height?: number;
  hullDirection?: number;
  turretDirection?: number;
  launchAngle?: number;
  cannonPower?: number;
  fire?: boolean;
  projectilePosition?: VectorRecord;
  projectileVelocity?: VectorRecord;
  projectileHeight?: number;
  projectileVerticalVelocity?: number;
  projectileStatus?: "active" | "exploding";
};

export type CommandTimelineRecord = {
  _id: string;
  matchId: string;
  playerId: string;
  tankId: string;
  queueType: "move" | "bearing" | "cannon";
  command: string;
  startedAt: number;
  endedAt: number;
  points: CommandTimelinePointRecord[];
  createdAt: number;
};
