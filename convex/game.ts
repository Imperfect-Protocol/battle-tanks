import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const BOARD_SIZE = 12;
const DEFAULT_LOBBY_ID = "pvp";
const MAX_HEALTH = 100;
const COMMAND_POINTS_PER_SQUARE = 10;
const UNITS_PER_SQUARE = 1000;
const UNITS_PER_COMMAND_POINT = UNITS_PER_SQUARE / COMMAND_POINTS_PER_SQUARE;
const TANK_LENGTH_UNITS = UNITS_PER_SQUARE * 1.18;
const TANK_WIDTH_UNITS = UNITS_PER_SQUARE * 0.62;
const TANK_COLLISION_RADIUS_UNITS = Math.hypot(TANK_LENGTH_UNITS / 2, TANK_WIDTH_UNITS / 2);
const TURRET_MOUNT_OFFSET_UNITS = -TANK_LENGTH_UNITS / 6;
const TURRET_BARREL_UNITS = TANK_LENGTH_UNITS * 0.62;
const PROJECTILE_HIT_RADIUS_UNITS = 750;
const PROJECTILE_GRAVITY_UNITS = 48;
const EXPLOSION_DURATION_MS = 360;
const MIN_TICK_INTERVAL_MS = 35;
const FRAME_RATE = 25;
const ROTATION_DEGREES_PER_TICK = 360 / (3 * FRAME_RATE);
const DEFAULT_MOVE_POINTS = 10;
const DEFAULT_TURN_DEGREES = 90;
const DEFAULT_FIRE_ANGLE_DEGREES = 45;
const DEFAULT_FIRE_POWER = 100;
const MIN_FIRE_POWER = 10;
const MAX_FIRE_POWER = 100;
const MAX_COMMAND_POINTS = BOARD_SIZE * COMMAND_POINTS_PER_SQUARE;
const MAX_COMMAND_DEGREES = 360;
const MAX_PROJECTILE_DAMAGE = 35;
const MIN_PROJECTILE_DAMAGE = 4;
const NORMAL_IQR_WIDTH_IN_SIGMA = 1.3489795003921634;
const PROJECTILE_DAMAGE_SIGMA = PROJECTILE_HIT_RADIUS_UNITS / NORMAL_IQR_WIDTH_IN_SIGMA;
const LEGACY_DIRECTION_DEGREES = {
  east: 0,
  south: 90,
  west: 180,
  north: 270,
} as const;
const LAUNCH_RANGE_BY_ANGLE: Record<number, number> = {
  30: 8 * UNITS_PER_SQUARE,
  45: 6 * UNITS_PER_SQUARE,
  60: 4 * UNITS_PER_SQUARE,
};

type StoredCommand =
  | { action: "wait"; amount: 0 }
  | { action: "lock" | "unlock"; amount: 0 }
  | {
      action: "forward" | "backward" | "left" | "right" | "turret" | "hull-step" | "turret-step";
      amount: number;
    }
  | { action: "fire"; power: number; angle: number };

export const getRoom = query({
  args: { roomCode: v.string() },
  returns: v.union(v.null(), v.any()),
  handler: async (ctx, args) => {
    const match = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q) => q.eq("roomCode", normalizeRoom(args.roomCode)))
      .unique();

    if (!match) {
      return null;
    }

    const board = await ctx.db.get(match.boardId);
    const players = await ctx.db
      .query("players")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .collect();
    const tanks = await ctx.db
      .query("tanks")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .collect();
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .collect();
    const projectiles = await ctx.db
      .query("projectiles")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .collect();

    return { match, board, players, tanks, orders, projectiles };
  },
});

export const listBattles = query({
  args: { lobbyId: v.optional(v.string()) },
  returns: v.array(
    v.object({
      _id: v.id("matches"),
      roomCode: v.string(),
      battleName: v.optional(v.string()),
      status: v.union(
        v.literal("lobby"),
        v.literal("active"),
        v.literal("finished"),
      ),
      currentTick: v.number(),
      playerCount: v.number(),
      maxPlayers: v.number(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const lobbyId = normalizeLobbyId(args.lobbyId);
    const matches = await ctx.db
      .query("matches")
      .withIndex("by_lobby_status_and_created_at", (q) => q.eq("lobbyId", lobbyId).eq("status", "lobby"))
      .order("desc")
      .take(25);

    const rows = [];
    for (const match of matches) {
      const players = await ctx.db
        .query("players")
        .withIndex("by_match", (q) => q.eq("matchId", match._id))
        .take(2);
      const tanks = await ctx.db
        .query("tanks")
        .withIndex("by_match", (q) => q.eq("matchId", match._id))
        .take(2);

      if (tanks.some((tank) => tank.health <= 0)) {
        continue;
      }

      if (players.length >= 2) {
        continue;
      }

      rows.push({
        _id: match._id,
        roomCode: match.roomCode,
        battleName: match.battleName,
        status: match.status,
        currentTick: match.currentTick,
        playerCount: players.length,
        maxPlayers: 2,
        createdAt: match.createdAt,
        updatedAt: match.updatedAt,
      });
    }

    return rows;
  },
});

export const createRoom = mutation({
  args: { roomCode: v.string(), playerName: v.string(), battleName: v.optional(v.string()) },
  returns: v.id("matches"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const roomCode = normalizeRoom(args.roomCode);
    const existing = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q) => q.eq("roomCode", roomCode))
      .unique();

    if (existing) {
      return existing._id;
    }

    const boardId = await ensureDefaultBoard(ctx, now);
    const matchId = await ctx.db.insert("matches", {
      boardId,
      roomCode,
      lobbyId: DEFAULT_LOBBY_ID,
      battleName: cleanBattleName(args.battleName),
      status: "lobby",
      currentTick: 0,
      lastTickAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const playerId = await ctx.db.insert("players", {
      matchId,
      name: cleanName(args.playerName),
      slot: "alpha",
      score: 0,
      createdAt: now,
    });
    await ctx.db.insert("tanks", {
      matchId,
      playerId,
      position: spawnPoint(0),
      velocity: { x: 0, y: 0 },
      hullDirection: 0,
      turretDirection: 0,
      turretLocked: true,
      ammoType: "missile",
      health: MAX_HEALTH,
      updatedAt: now,
    });

    return matchId;
  },
});

export const joinRoom = mutation({
  args: { roomCode: v.string(), playerName: v.string() },
  returns: v.id("matches"),
  handler: async (ctx, args) => {
    const now = Date.now();
    const roomCode = normalizeRoom(args.roomCode);
    const match = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q) => q.eq("roomCode", roomCode))
      .unique();

    if (!match) {
      throw new Error("Room not found");
    }

    const players = await ctx.db
      .query("players")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .collect();

    const playerName = cleanName(args.playerName);
    const existingPlayer = players.find((player) => player.name === playerName);
    if (existingPlayer) {
      return match._id;
    }

    if (players.length >= 2) {
      return match._id;
    }

    const slot = players.some((player) => player.slot === "alpha") ? "bravo" : "alpha";
    const playerId = await ctx.db.insert("players", {
      matchId: match._id,
      name: playerName,
      slot,
      score: 0,
      createdAt: now,
    });
    await ctx.db.insert("tanks", {
      matchId: match._id,
      playerId,
      position: slot === "alpha" ? spawnPoint(0) : spawnPoint(1),
      velocity: { x: 0, y: 0 },
      hullDirection: slot === "alpha" ? 0 : 180,
      turretDirection: slot === "alpha" ? 0 : 180,
      turretLocked: true,
      ammoType: "missile",
      health: MAX_HEALTH,
      updatedAt: now,
    });

    await ctx.db.patch(match._id, {
      status: "active",
      updatedAt: now,
    });

    return match._id;
  },
});

export const submitOrders = mutation({
  args: {
    roomCode: v.string(),
    playerName: v.string(),
    commands: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const roomCode = normalizeRoom(args.roomCode);
    const match = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q) => q.eq("roomCode", roomCode))
      .unique();

    if (!match) {
      throw new Error("Room not found");
    }

    const players = await ctx.db
      .query("players")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .collect();
    const player = players.find((candidate) => candidate.name === cleanName(args.playerName));
    if (!player) {
      throw new Error("Join the room before submitting orders");
    }

    const tanks = await ctx.db
      .query("tanks")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .collect();
    const tank = tanks.find((candidate) => candidate.playerId === player._id);
    if (!tank) {
      throw new Error("Tank not found");
    }

    await ctx.db.insert("orders", {
      matchId: match._id,
      playerId: player._id,
      tankId: tank._id,
      commands: args.commands.flatMap(normalizeOrderCommand),
      cursor: 0,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
    return null;
  },
});

export const runNextTick = mutation({
  args: { roomCode: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const roomCode = normalizeRoom(args.roomCode);
    const match = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q) => q.eq("roomCode", roomCode))
      .unique();

    if (!match || match.status === "finished") {
      return null;
    }

    if (now - (match.lastTickAt ?? 0) < MIN_TICK_INTERVAL_MS) {
      return null;
    }

    const board = await ctx.db.get(match.boardId);
    if (!board) {
      return null;
    }

    const tanks = await ctx.db
      .query("tanks")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .collect();
    const orders = await ctx.db
      .query("orders")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .collect();

    for (const tank of tanks) {
      const order = orders.find(
        (candidate) => candidate.tankId === tank._id && candidate.status !== "complete",
      );
      const command = order ? order.commands[order.cursor] : undefined;
      await applyCommand(ctx, board, tanks, tank, command, now);

      if (order) {
        const cursor = order.cursor + 1;
        await ctx.db.patch(order._id, {
          cursor,
          status: cursor >= order.commands.length ? "complete" : "running",
          updatedAt: now,
        });
      }
    }

    const wasAlreadyDestroyed = tanks.some((tank) => tank.health <= 0);
    const wasDestroyedThisTick = await advanceProjectiles(ctx, match._id, board.size, now);
    await ctx.db.patch(match._id, {
      status: wasAlreadyDestroyed || wasDestroyedThisTick ? "finished" : match.status,
      currentTick: match.currentTick + 1,
      lastTickAt: now,
      updatedAt: now,
    });
    return null;
  },
});

async function ensureDefaultBoard(ctx: any, now: number) {
  const existing = await ctx.db
    .query("boards")
    .withIndex("by_code", (q: any) => q.eq("code", "classic"))
    .unique();

  if (existing) {
    return existing._id;
  }

  const walls = [];
  for (let index = 0; index < BOARD_SIZE; index += 1) {
    walls.push({ x: index, y: 0 });
    walls.push({ x: index, y: BOARD_SIZE - 1 });
    walls.push({ x: 0, y: index });
    walls.push({ x: BOARD_SIZE - 1, y: index });
  }

  return await ctx.db.insert("boards", {
    code: "classic",
    name: "Classic Arena",
    size: BOARD_SIZE,
    walls,
    spawnPoints: [
      spawnPoint(0),
      spawnPoint(1),
    ],
    createdAt: now,
  });
}

async function applyCommand(ctx: any, board: any, tanks: any[], tank: any, command: string | undefined, now: number) {
  if (tank.health <= 0 || !command) {
    return;
  }

  const parsed = parseStoredCommand(command);
  if (!parsed) {
    return;
  }

  if (parsed.action === "hull-step") {
    await patchHullRotation(ctx, tank, parsed.amount, now);
    return;
  }

  if (parsed.action === "turret-step") {
    await ctx.db.patch(tank._id, {
      turretDirection: normalizeDegrees(angleFromDirection(tank.turretDirection) + parsed.amount),
      updatedAt: now,
    });
    return;
  }

  if (parsed.action === "left" || parsed.action === "right") {
    const direction = parsed.action === "right" ? 1 : -1;
    await patchHullRotation(ctx, tank, direction * parsed.amount, now);
    return;
  }

  if (parsed.action === "lock" || parsed.action === "unlock") {
    await ctx.db.patch(tank._id, {
      turretLocked: parsed.action === "lock",
      updatedAt: now,
    });
    return;
  }

  if (parsed.action === "turret") {
    await ctx.db.patch(tank._id, {
      turretDirection: normalizeDegrees(angleFromDirection(tank.turretDirection) + parsed.amount),
      updatedAt: now,
    });
    return;
  }

  if (parsed.action === "fire") {
    const launch = launchVelocity(parsed.power, parsed.angle);
    const velocity = vectorFromDegrees(angleFromDirection(tank.turretDirection), launch.horizontal);
    const mountOffset = vectorFromDegrees(angleFromDirection(tank.hullDirection), TURRET_MOUNT_OFFSET_UNITS);
    const barrelVector = vectorFromDegrees(angleFromDirection(tank.turretDirection), TURRET_BARREL_UNITS);
    const muzzle = {
      x: tank.position.x + mountOffset.x + barrelVector.x,
      y: tank.position.y + mountOffset.y + barrelVector.y,
    };
    await ctx.db.insert("projectiles", {
      matchId: tank.matchId,
      ownerTankId: tank._id,
      position: clampProjectilePosition(muzzle, board.size),
      velocity,
      damage: MAX_PROJECTILE_DAMAGE,
      height: 0,
      verticalVelocity: launch.vertical,
      launchPower: parsed.power,
      launchAngle: parsed.angle,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  if (parsed.action === "forward" || parsed.action === "backward") {
    const direction = parsed.action === "forward" ? 1 : -1;
    const velocity = vectorFromDegrees(
      angleFromDirection(tank.hullDirection),
      direction * commandPointsToUnits(parsed.amount),
    );
    const position = {
      x: tank.position.x + velocity.x,
      y: tank.position.y + velocity.y,
    };
    const nextPosition = resolveTankMove(position, board, tanks, tank);
    const moved = distanceBetween(nextPosition, tank.position) > 0.001;
    await ctx.db.patch(tank._id, {
      position: nextPosition,
      velocity: moved ? velocity : { x: 0, y: 0 },
      updatedAt: now,
    });
  }
}

async function advanceProjectiles(ctx: any, matchId: any, boardSize: number, now: number) {
  let destroyedTank = false;
  const tanks = await ctx.db
    .query("tanks")
    .withIndex("by_match", (q: any) => q.eq("matchId", matchId))
    .collect();
  const projectiles = await ctx.db
    .query("projectiles")
    .withIndex("by_match", (q: any) => q.eq("matchId", matchId))
    .collect();

  for (const projectile of projectiles.filter((item: any) => item.status === "active" || item.status === "exploding")) {
    if (projectile.status === "exploding") {
      if ((projectile.explosionEndsAt ?? 0) <= now) {
        await ctx.db.patch(projectile._id, { status: "spent", updatedAt: now });
      }
      continue;
    }

    if (projectile.createdAt >= now) {
      continue;
    }

    const nextPosition = {
      x: projectile.position.x + projectile.velocity.x,
      y: projectile.position.y + projectile.velocity.y,
    };
    const height = projectile.height ?? 0;
    const verticalVelocity = projectile.verticalVelocity ?? 0;
    const nextHeight = height + verticalVelocity;
    const nextVerticalVelocity = verticalVelocity - PROJECTILE_GRAVITY_UNITS;

    const hitsWall =
      nextPosition.x <= UNITS_PER_SQUARE ||
      nextPosition.y <= UNITS_PER_SQUARE ||
      nextPosition.x >= boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE ||
      nextPosition.y >= boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE;
    const hitsGround = nextHeight <= 0 && nextVerticalVelocity < 0;

    if (hitsGround && !hitsWall) {
      destroyedTank = (await applyBlastDamage(ctx, tanks, projectile, nextPosition, now)) || destroyedTank;
    }

    await ctx.db.patch(projectile._id, {
      position: clampProjectilePosition(nextPosition, boardSize),
      height: Math.max(0, nextHeight),
      verticalVelocity: nextVerticalVelocity,
      explosionEndsAt: hitsWall || hitsGround ? now + EXPLOSION_DURATION_MS : projectile.explosionEndsAt,
      status: hitsWall || hitsGround ? "exploding" : "active",
      updatedAt: now,
    });
  }

  return destroyedTank;
}

function normalizeRoom(roomCode: string) {
  return roomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "WWEFFP";
}

function normalizeLobbyId(lobbyId: string | undefined) {
  return lobbyId?.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || DEFAULT_LOBBY_ID;
}

function cleanName(name: string) {
  return name.trim().slice(0, 32) || "Commander";
}

function cleanBattleName(name: string | undefined) {
  return name?.trim().slice(0, 48) || "Battle";
}

function normalizeOrderCommand(command: string) {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  const parsed = parseStoredCommand(normalized);
  if (!parsed) {
    return [];
  }
  if (parsed.action === "wait") {
    return ["wait"];
  }
  if (parsed.action === "lock" || parsed.action === "unlock") {
    return [parsed.action];
  }
  if (parsed.action === "forward" || parsed.action === "backward") {
    return repeatCommand(`${parsed.action} 1`, parsed.amount);
  }
  if (parsed.action === "left") {
    return expandRotationCommand("hull-step", -parsed.amount);
  }
  if (parsed.action === "right") {
    return expandRotationCommand("hull-step", parsed.amount);
  }
  if (parsed.action === "turret") {
    return expandRotationCommand("turret-step", parsed.amount);
  }
  if (parsed.action === "hull-step" || parsed.action === "turret-step") {
    return [`${parsed.action} ${roundForStorage(parsed.amount)}`];
  }
  if (parsed.action === "fire") {
    return [`fire ${parsed.power} ${parsed.angle}`];
  }
  return [];
}

function parseStoredCommand(command: string): StoredCommand | null {
  const [action, rawAmount, rawSecondAmount] = command.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
  if (action === "wait") {
    return { action, amount: 0 };
  }

  if (action === "lock" || action === "unlock") {
    return { action, amount: 0 };
  }

  if (action === "forward") {
    return { action, amount: boundedAmount(rawAmount, DEFAULT_MOVE_POINTS, 0, MAX_COMMAND_POINTS) };
  }

  if (action === "backward") {
    return { action, amount: boundedAmount(rawAmount, DEFAULT_MOVE_POINTS, 0, MAX_COMMAND_POINTS) };
  }

  if (action === "fire") {
    if (rawSecondAmount === undefined) {
      return {
        action,
        power: DEFAULT_FIRE_POWER,
        angle: roundForStorage(boundedNumber(rawAmount, DEFAULT_FIRE_ANGLE_DEGREES, 30, 60)),
      };
    }

    return {
      action,
      power: roundForStorage(boundedNumber(rawAmount, DEFAULT_FIRE_POWER, MIN_FIRE_POWER, MAX_FIRE_POWER)),
      angle: roundForStorage(boundedNumber(rawSecondAmount, DEFAULT_FIRE_ANGLE_DEGREES, 30, 60)),
    };
  }

  if (action === "hull-step" || action === "turret-step") {
    return {
      action,
      amount: boundedNumber(rawAmount, 0, -ROTATION_DEGREES_PER_TICK, ROTATION_DEGREES_PER_TICK),
    };
  }

  if (action === "left" || action === "right") {
    return {
      action,
      amount: roundForStorage(boundedNumber(rawAmount, DEFAULT_TURN_DEGREES, 0, MAX_COMMAND_DEGREES)),
    };
  }

  if (action === "turret") {
    return {
      action,
      amount: roundForStorage(boundedNumber(rawAmount, 0, -MAX_COMMAND_DEGREES, MAX_COMMAND_DEGREES)),
    };
  }

  return null;
}

function boundedAmount(rawAmount: string | undefined, fallback: number, min: number, max: number) {
  const amount = boundedNumber(rawAmount, fallback, min, max);
  return Math.round(amount);
}

function boundedNumber(rawAmount: string | undefined, fallback: number, min: number, max: number) {
  const amount = rawAmount === undefined ? fallback : Number(rawAmount);
  if (!Number.isFinite(amount)) {
    return fallback;
  }
  return clamp(amount, min, max);
}

function repeatCommand(command: string, times: number) {
  return Array.from({ length: times }, () => command);
}

function expandRotationCommand(action: "hull-step" | "turret-step", degrees: number) {
  const stepCount = Math.max(1, Math.ceil(Math.abs(degrees) / ROTATION_DEGREES_PER_TICK));
  const stepDegrees = degrees / stepCount;
  return Array.from({ length: stepCount }, () => `${action} ${roundForStorage(stepDegrees)}`);
}

function vectorFromDegrees(degrees: number, magnitude: number) {
  const radians = (normalizeDegrees(degrees) * Math.PI) / 180;
  return {
    x: Math.cos(radians) * magnitude,
    y: Math.sin(radians) * magnitude,
  };
}

async function patchHullRotation(ctx: any, tank: any, delta: number, now: number) {
  const hullDirection = normalizeDegrees(angleFromDirection(tank.hullDirection) + delta);
  const patch = tank.turretLocked
    ? {
        hullDirection,
        turretDirection: normalizeDegrees(angleFromDirection(tank.turretDirection) + delta),
        updatedAt: now,
      }
    : {
        hullDirection,
        updatedAt: now,
      };

  await ctx.db.patch(tank._id, patch);
}

async function applyBlastDamage(
  ctx: any,
  tanks: any[],
  projectile: any,
  impactPosition: { x: number; y: number },
  now: number,
) {
  const target = tanks
    .filter((tank: any) => tank._id !== projectile.ownerTankId && tank.health > 0)
    .map((tank: any) => ({
      tank,
      impactDistance: distanceBetween(tank.position, impactPosition),
    }))
    .filter((candidate: any) => candidate.impactDistance <= PROJECTILE_HIT_RADIUS_UNITS)
    .sort((a: any, b: any) => a.impactDistance - b.impactDistance)[0];

  if (!target) {
    return false;
  }

  const damage = damageForImpact(target.impactDistance, projectile.damage);
  const health = Math.max(0, target.tank.health - damage);
  await ctx.db.patch(target.tank._id, { health, updatedAt: now });
  return health <= 0;
}

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function angleFromDirection(direction: number | keyof typeof LEGACY_DIRECTION_DEGREES) {
  if (typeof direction === "number" && Number.isFinite(direction)) {
    return direction;
  }
  if (typeof direction === "string") {
    return LEGACY_DIRECTION_DEGREES[direction];
  }
  return 0;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampPosition(position: { x: number; y: number }, boardSize: number) {
  const min = UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS;
  const max = boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS;
  return {
    x: clamp(position.x, min, max),
    y: clamp(position.y, min, max),
  };
}

function resolveTankMove(position: { x: number; y: number }, board: any, tanks: any[], movingTank: any) {
  const nextPosition = clampPosition(position, board.size);
  if (tankCollidesWithWalls(nextPosition, board.walls) || tankCollidesWithTanks(nextPosition, tanks, movingTank)) {
    return movingTank.position;
  }

  return nextPosition;
}

function tankCollidesWithWalls(position: { x: number; y: number }, walls: { x: number; y: number }[]) {
  return walls.some((wall) => circleIntersectsCell(position, wall));
}

function circleIntersectsCell(center: { x: number; y: number }, cell: { x: number; y: number }) {
  const minX = cell.x * UNITS_PER_SQUARE;
  const minY = cell.y * UNITS_PER_SQUARE;
  const maxX = minX + UNITS_PER_SQUARE;
  const maxY = minY + UNITS_PER_SQUARE;
  const closestX = clamp(center.x, minX, maxX);
  const closestY = clamp(center.y, minY, maxY);
  return distanceBetween(center, { x: closestX, y: closestY }) < TANK_COLLISION_RADIUS_UNITS;
}

function tankCollidesWithTanks(position: { x: number; y: number }, tanks: any[], movingTank: any) {
  return tanks.some(
    (tank) =>
      tank._id !== movingTank._id &&
      tank.health > 0 &&
      distanceBetween(position, tank.position) < TANK_COLLISION_RADIUS_UNITS * 2,
  );
}

function clampProjectilePosition(position: { x: number; y: number }, boardSize: number) {
  const min = UNITS_PER_SQUARE;
  const max = boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE;
  return {
    x: clamp(position.x, min, max),
    y: clamp(position.y, min, max),
  };
}

function spawnPoint(index: 0 | 1) {
  const cell = index === 0 ? 1 : BOARD_SIZE - 2;
  return {
    x: cell * UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS,
    y: cell * UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS,
  };
}

function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function damageForImpact(distanceFromCenter: number, peakDamage: number) {
  if (distanceFromCenter > PROJECTILE_HIT_RADIUS_UNITS) {
    return 0;
  }

  const gaussian = Math.exp(-0.5 * (distanceFromCenter / PROJECTILE_DAMAGE_SIGMA) ** 2);
  return clamp(Math.round(peakDamage * gaussian), MIN_PROJECTILE_DAMAGE, peakDamage);
}

function commandPointsToUnits(points: number) {
  return points * UNITS_PER_COMMAND_POINT;
}

function launchVelocity(power: number, angle: number) {
  const launchAngle = clamp(angle, 30, 60);
  const radians = (launchAngle * Math.PI) / 180;
  const targetRange = fullPowerRangeForAngle(launchAngle) * (power / 100);
  const launchSpeed = Math.sqrt(targetRange * PROJECTILE_GRAVITY_UNITS / Math.sin(2 * radians));
  return {
    horizontal: Math.cos(radians) * launchSpeed,
    vertical: Math.sin(radians) * launchSpeed,
  };
}

function fullPowerRangeForAngle(angle: number) {
  if (angle <= 45) {
    return interpolate(angle, 30, LAUNCH_RANGE_BY_ANGLE[30], 45, LAUNCH_RANGE_BY_ANGLE[45]);
  }
  return interpolate(angle, 45, LAUNCH_RANGE_BY_ANGLE[45], 60, LAUNCH_RANGE_BY_ANGLE[60]);
}

function interpolate(value: number, from: number, fromValue: number, to: number, toValue: number) {
  const t = (value - from) / (to - from);
  return fromValue + (toValue - fromValue) * t;
}

function roundForStorage(value: number) {
  return Math.round(value * 10000) / 10000;
}
