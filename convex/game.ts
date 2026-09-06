import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";

const BOARD_SIZE = 12;
const DEFAULT_LOBBY_ID = "pvp";
const MAX_HEALTH = 100;
const UNITS_PER_SQUARE = 1000;
const TANK_LENGTH_UNITS = UNITS_PER_SQUARE * 1.18;
const TANK_WIDTH_UNITS = UNITS_PER_SQUARE * 0.62;
const TANK_COLLISION_RADIUS_UNITS = Math.hypot(TANK_LENGTH_UNITS / 2, TANK_WIDTH_UNITS / 2);
const PROJECTILE_HIT_RADIUS_UNITS = 750;
const PROJECTILE_GRAVITY_UNITS = 48;
const EXPLOSION_DURATION_MS = 360;
const MIN_TICK_INTERVAL_MS = 35;
const FRAME_RATE = 25;
const ROTATION_DEGREES_PER_TICK = 360 / (3 * FRAME_RATE);
const DEFAULT_FIRE_ANGLE_DEGREES = 45;
const DEFAULT_FIRE_POWER = 100;
const MIN_FIRE_POWER = 10;
const MAX_FIRE_POWER = 100;
const MAX_RUN_SPEED = 30;
const MAX_COMMAND_DEGREES = 360;
const MAX_PROJECTILE_DAMAGE = 35;
const MIN_PROJECTILE_DAMAGE = 4;
const COLLISION_DAMAGE_PER_SPEED = 0.45;
const MAX_COLLISION_DAMAGE = 45;
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
const DEFAULT_TANK_SPEC = {
  hullColor: "#24f7a7",
  turretOffset: 0.333,
  cannonLength: 0.4,
  turretSize: 0.92,
};
const TANK_COLORS = ["#24f7a7", "#40d8ff", "#ffe45c", "#ff6b9d", "#b5ff5c", "#ff9c45"];
const TURRET_OFFSETS = [0.28, 0.333, 0.4, 0.48, 0.58];
const CANNON_LENGTHS = [0.32, 0.38, 0.44, 0.5, 0.56];
const TURRET_SIZES = [0.76, 0.84, 0.92, 1, 1.06];

type StoredCommand =
  | { action: "wait"; amount: 0 }
  | { action: "stop" | "lock" | "unlock"; amount: 0 }
  | {
    action: "run" | "turn" | "hull-step" | "turret-step" | "aim-angle";
    amount: number;
  }
  | { action: "aim"; horizontal: number; vertical: number }
  | { action: "fire"; power: number };

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
  args: {
    roomCode: v.string(),
    commanderId: v.id("commanderProfiles"),
    battleName: v.optional(v.string()),
  },
  returns: v.id("matches"),
  handler: async (ctx, args) => {
    const commander = await requireCommanderProfile(ctx, args.commanderId);
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
      userId: commander.userId,
      commanderId: commander.commanderId,
      name: commander.displayName,
      slot: "alpha",
      score: 0,
      createdAt: now,
    });
    await ctx.db.insert("tanks", {
      matchId,
      playerId,
      position: spawnPoint(0),
      velocity: { x: 0, y: 0 },
      speed: 0,
      hullDirection: 0,
      turretDirection: 0,
      turretLocked: true,
      tankSpec: commander.tankSpec,
      ammoType: "missile",
      launchAngle: DEFAULT_FIRE_ANGLE_DEGREES,
      health: MAX_HEALTH,
      updatedAt: now,
    });

    return matchId;
  },
});

export const joinRoom = mutation({
  args: { roomCode: v.string(), commanderId: v.id("commanderProfiles") },
  returns: v.id("matches"),
  handler: async (ctx, args) => {
    const commander = await requireCommanderProfile(ctx, args.commanderId);
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

    const existingPlayer = players.find((player) => player.commanderId === commander.commanderId);
    if (existingPlayer) {
      return match._id;
    }

    if (players.length >= 2) {
      return match._id;
    }

    const slot = players.some((player) => player.slot === "alpha") ? "bravo" : "alpha";
    const playerId = await ctx.db.insert("players", {
      matchId: match._id,
      userId: commander.userId,
      commanderId: commander.commanderId,
      name: commander.displayName,
      slot,
      score: 0,
      createdAt: now,
    });
    await ctx.db.insert("tanks", {
      matchId: match._id,
      playerId,
      position: slot === "alpha" ? spawnPoint(0) : spawnPoint(1),
      velocity: { x: 0, y: 0 },
      speed: 0,
      hullDirection: slot === "alpha" ? 0 : 180,
      turretDirection: slot === "alpha" ? 0 : 180,
      turretLocked: true,
      tankSpec: commander.tankSpec,
      ammoType: "missile",
      launchAngle: DEFAULT_FIRE_ANGLE_DEGREES,
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
    commanderId: v.id("commanderProfiles"),
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
    const commander = await requireCommanderProfile(ctx, args.commanderId);
    const player = players.find((candidate) => candidate.commanderId === commander.commanderId);
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
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Sign in before advancing battle");
    }

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

    const players = await ctx.db
      .query("players")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .collect();
    if (!players.some((player) => player.userId === userId)) {
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

    let wasDestroyedByCollision = false;
    for (const tank of tanks) {
      const order = orders.find(
        (candidate) => candidate.tankId === tank._id && candidate.status !== "complete",
      );
      const command = order ? order.commands[order.cursor] : undefined;
      const tankBeforeCommand = await ctx.db.get(tank._id);
      if (!tankBeforeCommand) {
        continue;
      }

      await applyCommand(ctx, board, tankBeforeCommand, command, now);

      if (order) {
        const cursor = order.cursor + 1;
        await ctx.db.patch(order._id, {
          cursor,
          status: cursor >= order.commands.length ? "complete" : "running",
          updatedAt: now,
        });
      }

      const tankAfterCommand = await ctx.db.get(tank._id);
      if (!tankAfterCommand) {
        continue;
      }

      const latestTanks = await ctx.db
        .query("tanks")
        .withIndex("by_match", (q) => q.eq("matchId", match._id))
        .collect();
      wasDestroyedByCollision = (await advanceTankMotion(ctx, board, latestTanks, tankAfterCommand, now)) || wasDestroyedByCollision;
    }

    const wasAlreadyDestroyed = tanks.some((tank) => tank.health <= 0);
    const wasDestroyedThisTick = await advanceProjectiles(ctx, match._id, board.size, now);
    await ctx.db.patch(match._id, {
      status: wasAlreadyDestroyed || wasDestroyedByCollision || wasDestroyedThisTick ? "finished" : match.status,
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

async function requireCommanderProfile(ctx: any, commanderId: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new Error("Sign in before entering battle");
  }

  const profile = await ctx.db.get(commanderId);

  if (!profile || profile.userId !== userId) {
    throw new Error("Choose a commander name before entering battle");
  }

  return {
    commanderId: profile._id,
    userId,
    displayName: profile.displayName,
    tankSpec: normalizeTankSpec(profile.tankSpec ?? tankSpecFromSeed(`${profile._id}:${profile.displayName}`)),
  };
}

async function applyCommand(ctx: any, board: any, tank: any, command: string | undefined, now: number) {
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

  if (parsed.action === "aim-angle") {
    await ctx.db.patch(tank._id, {
      launchAngle: parsed.amount,
      updatedAt: now,
    });
    return;
  }

  if (parsed.action === "run") {
    const velocity = vectorFromDegrees(angleFromDirection(tank.hullDirection), speedToUnitsPerTick(parsed.amount));
    await ctx.db.patch(tank._id, {
      speed: parsed.amount,
      velocity,
      updatedAt: now,
    });
    return;
  }

  if (parsed.action === "stop") {
    await ctx.db.patch(tank._id, {
      speed: 0,
      velocity: { x: 0, y: 0 },
      updatedAt: now,
    });
    return;
  }

  if (parsed.action === "lock" || parsed.action === "unlock") {
    await ctx.db.patch(tank._id, {
      turretLocked: parsed.action === "lock",
      updatedAt: now,
    });
    return;
  }

  if (parsed.action === "turn") {
    await patchHullRotation(ctx, tank, parsed.amount, now);
    return;
  }

  if (parsed.action === "fire") {
    const launch = launchVelocity(parsed.power, tank.launchAngle ?? DEFAULT_FIRE_ANGLE_DEGREES);
    const velocity = vectorFromDegrees(angleFromDirection(tank.turretDirection), launch.horizontal);
    const tankSpec = normalizeTankSpec(tank.tankSpec);
    const mountOffset = vectorFromDegrees(
      angleFromDirection(tank.hullDirection),
      (tankSpec.turretOffset - 0.5) * TANK_LENGTH_UNITS,
    );
    const barrelVector = vectorFromDegrees(
      angleFromDirection(tank.turretDirection),
      (tankSpec.turretSize * TANK_WIDTH_UNITS) / 2 + tankSpec.cannonLength * TANK_LENGTH_UNITS,
    );
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
      launchAngle: tank.launchAngle ?? DEFAULT_FIRE_ANGLE_DEGREES,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    return;
  }

  return;
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

async function advanceTankMotion(ctx: any, board: any, tanks: any[], tank: any, now: number) {
  if (tank.health <= 0) {
    return false;
  }

  const speed = clampFinite(tank.speed, 0, MAX_RUN_SPEED, 0);
  if (speed <= 0) {
    return false;
  }

  const velocity = vectorFromDegrees(angleFromDirection(tank.hullDirection), speedToUnitsPerTick(speed));
  const desiredPosition = {
    x: tank.position.x + velocity.x,
    y: tank.position.y + velocity.y,
  };
  const move = resolveTankMove(desiredPosition, board, tanks, tank);

  if (!move.wallHit && !move.tankHit) {
    await ctx.db.patch(tank._id, {
      position: move.position,
      velocity,
      updatedAt: now,
    });
    return false;
  }

  const damage = collisionDamageForSpeed(speed);
  const movingHealth = Math.max(0, tank.health - damage);
  await ctx.db.patch(tank._id, {
    position: tank.position,
    velocity: { x: 0, y: 0 },
    speed: 0,
    health: movingHealth,
    updatedAt: now,
  });

  let hitTankDestroyed = false;
  if (move.tankHit) {
    const hitHealth = Math.max(0, move.tankHit.health - damage);
    hitTankDestroyed = hitHealth <= 0;
    await ctx.db.patch(move.tankHit._id, {
      velocity: { x: 0, y: 0 },
      speed: 0,
      health: hitHealth,
      updatedAt: now,
    });
  }

  return movingHealth <= 0 || hitTankDestroyed;
}

function normalizeRoom(roomCode: string) {
  return roomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "WWEFFP";
}

function normalizeLobbyId(lobbyId: string | undefined) {
  return lobbyId?.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || DEFAULT_LOBBY_ID;
}

function cleanBattleName(name: string | undefined) {
  return name?.trim().slice(0, 48) || "Battle";
}

function normalizeOrderCommand(command: string): string[] {
  if (/[;,\n]/.test(command)) {
    return command.split(/[;,\n]+/).flatMap(normalizeOrderCommand);
  }

  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  const parsed = parseStoredCommand(normalized);
  if (!parsed) {
    return [];
  }
  if (parsed.action === "wait") {
    return ["wait"];
  }
  if (parsed.action === "stop" || parsed.action === "lock" || parsed.action === "unlock") {
    return [parsed.action];
  }
  if (parsed.action === "run") {
    return [`run ${roundForStorage(parsed.amount)}`];
  }
  if (parsed.action === "turn") {
    return expandRotationCommand("hull-step", parsed.amount);
  }
  if (parsed.action === "aim") {
    return [
      ...expandRotationCommand("turret-step", parsed.horizontal),
      `aim-angle ${roundForStorage(parsed.vertical)}`,
    ];
  }
  if (parsed.action === "hull-step" || parsed.action === "turret-step" || parsed.action === "aim-angle") {
    return [`${parsed.action} ${roundForStorage(parsed.amount)}`];
  }
  if (parsed.action === "fire") {
    return [`fire ${parsed.power}`];
  }
  return [];
}

function parseStoredCommand(command: string): StoredCommand | null {
  const [action, rawAmount, rawSecondAmount, extra] = command.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
  if (extra !== undefined) {
    return null;
  }

  if (action === "wait") {
    return rawAmount === undefined ? { action, amount: 0 } : null;
  }

  if (action === "stop" || action === "lock" || action === "unlock") {
    return rawAmount === undefined ? { action, amount: 0 } : null;
  }

  if (action === "run") {
    if (rawAmount === undefined) {
      return null;
    }
    return { action, amount: roundForStorage(boundedNumber(rawAmount, 0, 0, MAX_RUN_SPEED)) };
  }

  if (action === "fire") {
    if (rawAmount === undefined || rawSecondAmount !== undefined) {
      return null;
    }

    return {
      action,
      power: roundForStorage(boundedNumber(rawAmount, DEFAULT_FIRE_POWER, MIN_FIRE_POWER, MAX_FIRE_POWER)),
    };
  }

  if (action === "hull-step" || action === "turret-step") {
    return {
      action,
      amount: boundedNumber(rawAmount, 0, -ROTATION_DEGREES_PER_TICK, ROTATION_DEGREES_PER_TICK),
    };
  }

  if (action === "aim-angle") {
    if (rawAmount === undefined) {
      return null;
    }

    return {
      action,
      amount: roundForStorage(boundedNumber(rawAmount, DEFAULT_FIRE_ANGLE_DEGREES, 30, 60)),
    };
  }

  if (action === "turn") {
    if (rawAmount === undefined) {
      return null;
    }

    return {
      action,
      amount: roundForStorage(boundedNumber(rawAmount, 0, -MAX_COMMAND_DEGREES, MAX_COMMAND_DEGREES)),
    };
  }

  if (action === "aim") {
    if (rawAmount === undefined || rawSecondAmount === undefined) {
      return null;
    }

    return {
      action,
      horizontal: roundForStorage(boundedNumber(rawAmount, 0, -MAX_COMMAND_DEGREES, MAX_COMMAND_DEGREES)),
      vertical: roundForStorage(boundedNumber(rawSecondAmount, DEFAULT_FIRE_ANGLE_DEGREES, 30, 60)),
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
  const wallHit = distanceBetween(position, nextPosition) > 0.001 || tankCollidesWithWalls(nextPosition, board.walls);
  const tankHit = findTankCollision(nextPosition, tanks, movingTank);
  if (wallHit || tankHit) {
    return {
      position: movingTank.position,
      wallHit,
      tankHit,
    };
  }

  return {
    position: nextPosition,
    wallHit: false,
    tankHit: null,
  };
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

function findTankCollision(position: { x: number; y: number }, tanks: any[], movingTank: any) {
  return (
    tanks.find(
      (tank) =>
        tank._id !== movingTank._id &&
        tank.health > 0 &&
        distanceBetween(position, tank.position) < TANK_COLLISION_RADIUS_UNITS * 2,
    ) ?? null
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
  return index === 0 ?
    {
      x: UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS,
      y: UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS,
    }
    :
    {
      x: (BOARD_SIZE - 1) * UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS,
      y: (BOARD_SIZE - 1) * UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS,
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

function speedToUnitsPerTick(speed: number) {
  const squaresPerSecond = (speed * 1000) / 3600;
  return (squaresPerSecond * UNITS_PER_SQUARE) / FRAME_RATE;
}

function collisionDamageForSpeed(speedKph: number) {
  if (speedKph <= 0) {
    return 0;
  }

  return clamp(Math.round(speedKph * COLLISION_DAMAGE_PER_SPEED), 1, MAX_COLLISION_DAMAGE);
}

function normalizeTankSpec(spec: any) {
  if (!spec) {
    return DEFAULT_TANK_SPEC;
  }

  return {
    hullColor: typeof spec.hullColor === "string" ? spec.hullColor : DEFAULT_TANK_SPEC.hullColor,
    turretOffset: clampFinite(spec.turretOffset, 0.24, 0.66, DEFAULT_TANK_SPEC.turretOffset),
    cannonLength: clampFinite(spec.cannonLength, 0.3, 0.56, DEFAULT_TANK_SPEC.cannonLength),
    turretSize: clampFinite(spec.turretSize, 0.74, 1.06, DEFAULT_TANK_SPEC.turretSize),
  };
}

function tankSpecFromSeed(seed: string) {
  const hash = hashString(seed);

  return {
    hullColor: TANK_COLORS[pick(hash, 0, TANK_COLORS.length)],
    turretOffset: TURRET_OFFSETS[pick(hash, 8, TURRET_OFFSETS.length)],
    cannonLength: CANNON_LENGTHS[pick(hash, 16, CANNON_LENGTHS.length)],
    turretSize: TURRET_SIZES[pick(hash, 24, TURRET_SIZES.length)],
  };
}

function pick(hash: number, shift: number, length: number) {
  return Math.abs(hash >> shift) % length;
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash;
}

function clampFinite(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}
