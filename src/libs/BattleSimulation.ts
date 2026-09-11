import { GameRoom } from "./GameRoom";
import type { BoardRecord, PlayerCommandRecord, PlayerRecord, ProjectileRecord, TankRecord, WorldEventRecord } from "./types";

const BOARD_SIZE = 12;
const UNITS_PER_SQUARE = 1000;
const TANK_LENGTH_UNITS = UNITS_PER_SQUARE * 1.18;
const TANK_WIDTH_UNITS = UNITS_PER_SQUARE * 0.62;
const TANK_COLLISION_RADIUS_UNITS = Math.hypot(TANK_LENGTH_UNITS / 2, TANK_WIDTH_UNITS / 2);
const FRAME_RATE = 25;
const FRAME_MS = 1000 / FRAME_RATE;
const ROTATION_DEGREES_PER_TICK = 360 / (3 * FRAME_RATE);
const MAX_SPEED_UNITS_PER_TICK = (3 * UNITS_PER_SQUARE) / FRAME_RATE;
const ACCELERATION_UNITS_PER_TICK = MAX_SPEED_UNITS_PER_TICK / (FRAME_RATE * 0.8);
const PROJECTILE_GRAVITY_UNITS = 48;
const PROJECTILE_HIT_RADIUS_UNITS = 750;
const EXPLOSION_DURATION_MS = 1000;
const MAX_PROJECTILE_DAMAGE = 35;
const MIN_PROJECTILE_DAMAGE = 4;
const COLLISION_DAMAGE_PER_SPEED = 0.18;
const MAX_COLLISION_DAMAGE = 45;
const NORMAL_IQR_WIDTH_IN_SIGMA = 1.3489795003921634;
const PROJECTILE_DAMAGE_SIGMA = PROJECTILE_HIT_RADIUS_UNITS / NORMAL_IQR_WIDTH_IN_SIGMA;
const DEFAULT_FIRE_ANGLE_DEGREES = 45;
const DEFAULT_FIRE_POWER = 100;

type QueueType = "move" | "bearing" | "cannon";

type SimTank = TankRecord & {
  queues: Record<QueueType, string[]>;
  damagedByProjectiles: Set<string>;
};

type SimProjectile = ProjectileRecord & {
  createdAt: number;
  damagedTankIds: Set<string>;
};

export class BattleSimulation {
  private key = "";
  private match: GameRoom["match"] = null;
  private board: BoardRecord | null = null;
  private players: PlayerRecord[] = [];
  private tanks = new Map<string, SimTank>();
  private projectiles = new Map<string, SimProjectile>();
  private appliedCommandBatches = new Set<string>();
  private lastFrameAt = 0;
  private projectileSequence = 0;
  private finishedAt: number | undefined;
  private winnerPlayerId: string | undefined;

  sync(room: GameRoom | null, now: number) {
    if (!room?.match || !room.board) {
      return null;
    }

    const nextKey = `${room.match.roomCode}:${room.players.map((player) => player.id).join(":")}`;
    if (nextKey !== this.key) {
      this.reset(room, nextKey, now);
    } else {
      this.match = room.match;
      this.board = room.board.record;
      this.players = room.players.map((player) => player.record);
      for (const tank of room.tanks) {
        if (!this.tanks.has(tank.id)) {
          this.tanks.set(tank.id, createSimTank(tank.record));
        }
      }
    }

    this.applyCommandBatches(room.commandBatches);
    this.advance(now);
    return this.snapshot(room);
  }

  private reset(room: GameRoom, key: string, now: number) {
    this.key = key;
    this.match = room.match;
    this.board = room.board?.record ?? null;
    this.players = room.players.map((player) => player.record);
    this.tanks = new Map(room.tanks.map((tank) => [tank.id, createSimTank(tank.record)]));
    this.projectiles = new Map();
    this.appliedCommandBatches = new Set();
    this.lastFrameAt = now;
    this.projectileSequence = 0;
    this.finishedAt = undefined;
    this.winnerPlayerId = undefined;
  }

  private applyCommandBatches(commandBatches: PlayerCommandRecord[]) {
    const batches = [...commandBatches].sort((left, right) => left.createdAt - right.createdAt || left._id.localeCompare(right._id));
    for (const batch of batches) {
      if (this.appliedCommandBatches.has(batch._id)) {
        continue;
      }

      this.appliedCommandBatches.add(batch._id);
      const tank = this.tankForPlayer(batch.playerId);
      if (!tank || tank.health <= 0) {
        continue;
      }

      this.queueCommands(tank, batch.commands);
    }
  }

  private queueCommands(tank: SimTank, commands: string[]) {
    const next: Record<QueueType, string[]> = {
      move: [],
      bearing: [],
      cannon: [],
    };

    for (const command of commands) {
      const parsed = parseCommand(command);
      if (!parsed) {
        continue;
      }
      next[queueTypeForCommand(parsed.action)].push(command);
    }

    if (next.move.length > 0) {
      tank.queues.move.push(...next.move);
    }
    if (next.bearing.length > 0) {
      tank.queues.bearing = next.bearing;
    }
    if (next.cannon.length > 0) {
      tank.queues.cannon = next.cannon;
    }
  }

  private advance(now: number) {
    if (!this.board || this.finishedAt) {
      return;
    }

    const elapsedMs = Math.min(250, Math.max(0, now - this.lastFrameAt));
    if (elapsedMs <= 0) {
      return;
    }

    const ticks = elapsedMs / FRAME_MS;
    this.lastFrameAt = now;

    for (const tank of this.tanks.values()) {
      this.advanceTankCommands(tank, ticks, now);
    }

    for (const tank of this.tanks.values()) {
      this.advanceTankMotion(tank, ticks, now);
    }

    this.resolveTankCollisions(now);
    this.advanceProjectiles(ticks, now);
    this.resolveEnd(now);
  }

  private advanceTankCommands(tank: SimTank, ticks: number, now: number) {
    if (tank.health <= 0) {
      return;
    }

    const bearingCommand = tank.queues.bearing[0];
    if (bearingCommand) {
      const parsed = parseCommand(bearingCommand);
      if (parsed?.action === "bear") {
        const previousBearing = angleFromDirection(tank.hullDirection);
        const result = stepTowardBearing(previousBearing, parsed.value, ticks);
        tank.hullDirection = result.bearing;
        if (tank.turretLocked) {
          tank.turretDirection = normalizeDegrees(angleFromDirection(tank.turretDirection) + shortestAngleDelta(previousBearing, result.bearing));
        }
        tank.updatedAt = now;
        if (result.complete) {
          tank.queues.bearing.shift();
        }
      } else {
        tank.queues.bearing.shift();
      }
    }

    const cannonCommand = tank.queues.cannon[0];
    if (cannonCommand) {
      const complete = this.applyCannonCommand(tank, cannonCommand, ticks, now);
      if (complete) {
        tank.queues.cannon.shift();
      }
    }

    if (Math.abs(tank.moveRemaining ?? 0) <= 0.5 && tank.queues.move.length > 0) {
      const command = tank.queues.move.shift();
      const parsed = command ? parseCommand(command) : null;
      if (parsed?.action === "move") {
        tank.moveRemaining = (tank.moveRemaining ?? 0) + parsed.value * UNITS_PER_SQUARE;
        tank.activeMoveCommand = command;
        tank.updatedAt = now;
      }
    }
  }

  private applyCannonCommand(tank: SimTank, command: string, ticks: number, now: number) {
    const parsed = parseCommand(command);
    if (!parsed) {
      return true;
    }

    if (parsed.action === "aim") {
      const result = stepTowardBearing(angleFromDirection(tank.turretDirection), parsed.value, ticks);
      tank.turretDirection = result.bearing;
      tank.turretLocked = false;
      tank.updatedAt = now;
      return result.complete;
    }

    if (parsed.action === "elev") {
      tank.launchAngle = parsed.value;
      tank.updatedAt = now;
      return true;
    }

    if (parsed.action === "pow") {
      tank.cannonPower = parsed.value;
      tank.lastFirePower = parsed.value;
      tank.updatedAt = now;
      return true;
    }

    if (parsed.action === "ret") {
      const result = stepTowardBearing(angleFromDirection(tank.turretDirection), angleFromDirection(tank.hullDirection), ticks);
      tank.turretDirection = result.bearing;
      tank.turretLocked = result.complete;
      tank.updatedAt = now;
      return result.complete;
    }

    if (parsed.action === "fire") {
      this.fireProjectile(tank, now);
      return true;
    }

    return true;
  }

  private advanceTankMotion(tank: SimTank, ticks: number, now: number) {
    if (tank.health <= 0) {
      tank.velocity = { x: 0, y: 0 };
      tank.speed = 0;
      return;
    }

    const remaining = tank.moveRemaining ?? 0;
    if (Math.abs(remaining) <= 0.5) {
      tank.velocity = { x: 0, y: 0 };
      tank.speed = 0;
      tank.moveRemaining = 0;
      tank.activeMoveCommand = "";
      return;
    }

    const direction = Math.sign(remaining);
    const speed = signedSpeed(tank);
    const stoppingDistance = (speed * speed) / (2 * ACCELERATION_UNITS_PER_TICK);
    const targetSpeed = Math.abs(remaining) <= stoppingDistance + 20 ? 0 : direction * MAX_SPEED_UNITS_PER_TICK;
    const nextSpeed = stepToward(speed, targetSpeed, ACCELERATION_UNITS_PER_TICK * ticks);
    const travel = clampMagnitude(nextSpeed * ticks, Math.abs(remaining)) * Math.sign(nextSpeed || remaining);
    const vector = vectorFromBearing(angleFromDirection(tank.hullDirection), travel);

    tank.position = clampTankPosition({
      x: tank.position.x + vector.x,
      y: tank.position.y + vector.y,
    }, this.board?.size ?? BOARD_SIZE);
    tank.moveRemaining = remaining - travel;
    tank.speed = Math.abs(nextSpeed);
    tank.velocity = vectorFromBearing(angleFromDirection(tank.hullDirection), nextSpeed);
    tank.updatedAt = now;

    if (Math.abs(tank.moveRemaining) <= 0.5) {
      tank.moveRemaining = 0;
      tank.velocity = { x: 0, y: 0 };
      tank.speed = 0;
      tank.activeMoveCommand = "";
    }
  }

  private resolveTankCollisions(now: number) {
    const boardSize = this.board?.size ?? BOARD_SIZE;
    for (const tank of this.tanks.values()) {
      const clamped = clampTankPosition(tank.position, boardSize);
      const wallImpact = Math.hypot(tank.position.x - clamped.x, tank.position.y - clamped.y);
      if (wallImpact > 0.1) {
        this.damageTank(tank, collisionDamage(vectorLength(tank.velocity)), now);
        tank.position = clamped;
        tank.velocity = { x: 0, y: 0 };
        tank.speed = 0;
        tank.moveRemaining = 0;
        tank.queues.move = [];
      }
    }

    const tanks = [...this.tanks.values()].filter((tank) => tank.health > 0);
    for (let leftIndex = 0; leftIndex < tanks.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < tanks.length; rightIndex += 1) {
        const left = tanks[leftIndex];
        const right = tanks[rightIndex];
        const delta = {
          x: right.position.x - left.position.x,
          y: right.position.y - left.position.y,
        };
        const distance = Math.max(1, vectorLength(delta));
        const minimumDistance = TANK_COLLISION_RADIUS_UNITS * 2;
        if (distance >= minimumDistance) {
          continue;
        }

        const overlap = minimumDistance - distance;
        const normal = { x: delta.x / distance, y: delta.y / distance };
        left.position = clampTankPosition({ x: left.position.x - normal.x * overlap * 0.5, y: left.position.y - normal.y * overlap * 0.5 }, boardSize);
        right.position = clampTankPosition({ x: right.position.x + normal.x * overlap * 0.5, y: right.position.y + normal.y * overlap * 0.5 }, boardSize);
        const impact = vectorLength({
          x: left.velocity.x - right.velocity.x,
          y: left.velocity.y - right.velocity.y,
        });
        const damage = collisionDamage(impact);
        this.damageTank(left, damage, now);
        this.damageTank(right, damage, now);
        left.velocity = { x: 0, y: 0 };
        right.velocity = { x: 0, y: 0 };
        left.speed = 0;
        right.speed = 0;
        left.moveRemaining = 0;
        right.moveRemaining = 0;
        left.queues.move = [];
        right.queues.move = [];
      }
    }
  }

  private fireProjectile(tank: SimTank, now: number) {
    if (!this.board) {
      return;
    }

    const power = clampFinite(tank.cannonPower ?? tank.lastFirePower, 10, 100, DEFAULT_FIRE_POWER);
    const launch = launchVelocity(power, tank.launchAngle ?? DEFAULT_FIRE_ANGLE_DEGREES);
    const muzzleVelocity = vectorFromBearing(angleFromDirection(tank.turretDirection), launch.horizontal);
    const velocity = {
      x: muzzleVelocity.x + tank.velocity.x,
      y: muzzleVelocity.y + tank.velocity.y,
    };
    const tankSpec = tank.tankSpec ?? {
      hullColor: "#24f7a7",
      turretOffset: 0.333,
      cannonLength: 0.4,
      turretSize: 0.92,
    };
    const mountOffset = vectorFromBearing(
      angleFromDirection(tank.hullDirection),
      (tankSpec.turretOffset - 0.5) * TANK_LENGTH_UNITS,
    );
    const barrelVector = vectorFromBearing(
      angleFromDirection(tank.turretDirection),
      (tankSpec.turretSize * TANK_WIDTH_UNITS) / 2 + tankSpec.cannonLength * TANK_LENGTH_UNITS,
    );
    const muzzle = clampProjectilePosition({
      x: tank.position.x + mountOffset.x + barrelVector.x,
      y: tank.position.y + mountOffset.y + barrelVector.y,
    }, this.board.size);

    this.projectileSequence += 1;
    this.projectiles.set(`local-projectile-${this.projectileSequence}`, {
      _id: `local-projectile-${this.projectileSequence}`,
      ownerPlayerId: tank.playerId,
      ownerTankId: tank._id,
      position: muzzle,
      velocity,
      damage: MAX_PROJECTILE_DAMAGE,
      height: 0,
      verticalVelocity: launch.vertical,
      launchPower: power,
      launchAngle: tank.launchAngle ?? DEFAULT_FIRE_ANGLE_DEGREES,
      status: "active",
      createdAt: now,
      updatedAt: now,
      damagedTankIds: new Set(),
    });
    tank.lastFirePower = power;
    tank.updatedAt = now;
  }

  private advanceProjectiles(ticks: number, now: number) {
    const boardSize = this.board?.size ?? BOARD_SIZE;
    for (const projectile of this.projectiles.values()) {
      if (projectile.status === "spent") {
        continue;
      }

      if (projectile.status === "exploding") {
        if ((projectile.explosionEndsAt ?? 0) <= now) {
          projectile.status = "spent";
          projectile.updatedAt = now;
        }
        continue;
      }

      const nextPosition = {
        x: projectile.position.x + projectile.velocity.x * ticks,
        y: projectile.position.y + projectile.velocity.y * ticks,
      };
      const nextHeight = (projectile.height ?? 0) + (projectile.verticalVelocity ?? 0) * ticks;
      const nextVerticalVelocity = (projectile.verticalVelocity ?? 0) - PROJECTILE_GRAVITY_UNITS * ticks;
      const hitsWall =
        nextPosition.x <= UNITS_PER_SQUARE ||
        nextPosition.y <= UNITS_PER_SQUARE ||
        nextPosition.x >= boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE ||
        nextPosition.y >= boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE;
      const hitsGround = nextHeight <= 0 && nextVerticalVelocity < 0;

      projectile.position = clampProjectilePosition(nextPosition, boardSize);
      projectile.height = Math.max(0, nextHeight);
      projectile.verticalVelocity = nextVerticalVelocity;
      projectile.updatedAt = now;

      if (hitsWall || hitsGround) {
        projectile.status = "exploding";
        projectile.explosionEndsAt = now + EXPLOSION_DURATION_MS;
        projectile.height = 0;
        this.applyExplosion(projectile, now);
      }
    }
  }

  private applyExplosion(projectile: SimProjectile, now: number) {
    for (const tank of this.tanks.values()) {
      if (tank.health <= 0 || tank._id === projectile.ownerTankId || projectile.damagedTankIds.has(tank._id)) {
        continue;
      }

      const distance = distanceBetween(tank.position, projectile.position);
      if (distance > PROJECTILE_HIT_RADIUS_UNITS) {
        continue;
      }

      projectile.damagedTankIds.add(tank._id);
      this.damageTank(tank, damageForImpact(distance, projectile.damage), now);
    }
  }

  private damageTank(tank: SimTank, damage: number, now: number) {
    if (damage <= 0 || tank.health <= 0) {
      return;
    }

    tank.health = Math.max(0, tank.health - damage);
    tank.updatedAt = now;
    if (tank.health <= 0) {
      tank.velocity = { x: 0, y: 0 };
      tank.speed = 0;
      tank.moveRemaining = 0;
      tank.queues.move = [];
      tank.queues.bearing = [];
      tank.queues.cannon = [];
    }
  }

  private resolveEnd(now: number) {
    if (this.players.length < 2 || this.finishedAt) {
      return;
    }

    const alive = [...this.tanks.values()].filter((tank) => tank.health > 0);
    if (alive.length > 1) {
      return;
    }

    this.finishedAt = now;
    this.winnerPlayerId = alive[0]?.playerId;
  }

  private snapshot(room: GameRoom) {
    const match = this.match
      ? {
        ...this.match,
        status: this.finishedAt ? "finished" : room.ready ? "active" : this.match.status,
        winnerPlayerId: this.winnerPlayerId,
        finishedAt: this.finishedAt,
        updatedAt: this.lastFrameAt,
      }
      : null;
    const tanks = [...this.tanks.values()].map(snapshotTank);
    const projectiles = [...this.projectiles.values()]
      .filter((projectile) => projectile.status !== "spent")
      .map(snapshotProjectile);
    const events: WorldEventRecord[] = [];

    return new GameRoom(
      match,
      this.board,
      this.players,
      tanks,
      projectiles,
      [],
      events,
      room.commandBatches,
      false,
    );
  }

  private tankForPlayer(playerId: string) {
    return [...this.tanks.values()].find((tank) => tank.playerId === playerId);
  }
}

function createSimTank(record: TankRecord): SimTank {
  return {
    ...clone(record),
    queues: {
      move: [],
      bearing: [],
      cannon: [],
    },
    damagedByProjectiles: new Set(),
  };
}

function snapshotTank(tank: SimTank): TankRecord {
  const { queues, damagedByProjectiles, ...record } = tank;
  void queues;
  void damagedByProjectiles;
  return clone(record);
}

function snapshotProjectile(projectile: SimProjectile): ProjectileRecord {
  const { createdAt, damagedTankIds, ...record } = projectile;
  void createdAt;
  void damagedTankIds;
  return clone(record);
}

function parseCommand(command: string) {
  const [action, rawValue] = command.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
  if (action === "fire" || action === "ret") {
    return { action, value: 0 };
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return null;
  }

  if (action === "bear" || action === "move" || action === "aim" || action === "elev" || action === "pow") {
    return { action, value };
  }

  return null;
}

function queueTypeForCommand(action: string): QueueType {
  if (action === "move") {
    return "move";
  }
  if (action === "bear") {
    return "bearing";
  }
  return "cannon";
}

function stepTowardBearing(current: number, target: number, ticks: number) {
  const delta = shortestAngleDelta(current, target);
  const step = ROTATION_DEGREES_PER_TICK * ticks;
  if (Math.abs(delta) <= step) {
    return { bearing: normalizeDegrees(target), complete: true };
  }

  return {
    bearing: normalizeDegrees(current + Math.sign(delta) * step),
    complete: false,
  };
}

function signedSpeed(tank: TankRecord) {
  const speed = tank.speed ?? vectorLength(tank.velocity);
  const forward = vectorFromBearing(angleFromDirection(tank.hullDirection), 1);
  return dotProduct(tank.velocity, forward) >= 0 ? speed : -speed;
}

function launchVelocity(power: number, angle: number) {
  const launchAngle = clamp(angle, 10, 60);
  const radians = (launchAngle * Math.PI) / 180;
  const targetRange = fullPowerRangeForAngle(launchAngle) * (power / 100);
  const launchSpeed = Math.sqrt(targetRange * PROJECTILE_GRAVITY_UNITS / Math.sin(2 * radians));
  return {
    horizontal: Math.cos(radians) * launchSpeed,
    vertical: Math.sin(radians) * launchSpeed,
  };
}

function fullPowerRangeForAngle(angle: number) {
  if (angle <= 30) {
    return 8000;
  }
  if (angle <= 45) {
    return interpolate(angle, 30, 8000, 45, 6000);
  }
  return interpolate(angle, 45, 6000, 60, 4000);
}

function damageForImpact(distanceFromCenter: number, peakDamage: number) {
  if (distanceFromCenter > PROJECTILE_HIT_RADIUS_UNITS) {
    return 0;
  }

  const gaussian = Math.exp(-0.5 * (distanceFromCenter / PROJECTILE_DAMAGE_SIGMA) ** 2);
  return clamp(Math.round(peakDamage * gaussian), MIN_PROJECTILE_DAMAGE, peakDamage);
}

function collisionDamage(impactSpeed: number) {
  return clamp(Math.round(impactSpeed * COLLISION_DAMAGE_PER_SPEED), 0, MAX_COLLISION_DAMAGE);
}

function clampTankPosition(point: { x: number; y: number }, boardSize: number) {
  const min = UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS;
  const max = (boardSize - 1) * UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS;
  return {
    x: clamp(point.x, min, max),
    y: clamp(point.y, min, max),
  };
}

function clampProjectilePosition(point: { x: number; y: number }, boardSize: number) {
  const min = UNITS_PER_SQUARE;
  const max = boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE;
  return {
    x: clamp(point.x, min, max),
    y: clamp(point.y, min, max),
  };
}

function vectorFromBearing(degrees: number, magnitude: number) {
  const radians = ((normalizeDegrees(degrees) - 90) * Math.PI) / 180;
  return {
    x: Math.cos(radians) * magnitude,
    y: Math.sin(radians) * magnitude,
  };
}

function angleFromDirection(direction: number | "north" | "east" | "south" | "west") {
  if (typeof direction === "number" && Number.isFinite(direction)) {
    return direction;
  }
  return {
    north: 0,
    east: 90,
    south: 180,
    west: 270,
  }[direction] ?? 0;
}

function shortestAngleDelta(from: number, to: number) {
  return ((to - from + 540) % 360) - 180;
}

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function vectorLength(vector: { x: number; y: number }) {
  return Math.hypot(vector.x, vector.y);
}

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function dotProduct(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x * b.x + a.y * b.y;
}

function stepToward(current: number, target: number, step: number) {
  if (Math.abs(target - current) <= step) {
    return target;
  }
  return current + Math.sign(target - current) * step;
}

function clampMagnitude(value: number, maxMagnitude: number) {
  return Math.sign(value) * Math.min(Math.abs(value), maxMagnitude);
}

function clampFinite(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function interpolate(value: number, from: number, fromValue: number, to: number, toValue: number) {
  const progress = (value - from) / (to - from);
  return fromValue + (toValue - fromValue) * progress;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
