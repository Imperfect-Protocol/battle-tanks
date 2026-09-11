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
const WORLD_EVENT_TTL_MS = 5000;
const WORLD_EVENT_CLEANUP_WINDOW_MS = 60_000;
const MIN_TICK_INTERVAL_MS = 35;
const FRAME_RATE = 25;
const ROTATION_DEGREES_PER_TICK = 360 / (3 * FRAME_RATE);
const MAX_SPEED_UNITS_PER_TICK = (3 * UNITS_PER_SQUARE) / FRAME_RATE;
const ACCELERATION_UNITS_PER_TICK = MAX_SPEED_UNITS_PER_TICK / (FRAME_RATE * 0.8);
const REBOUND_SPEED_SCALE = 0.42;
const DEFAULT_FIRE_ANGLE_DEGREES = 45;
const DEFAULT_FIRE_POWER = 100;
const MIN_FIRE_POWER = 10;
const MAX_FIRE_POWER = 100;
const MIN_AIM_ELEVATION_DEGREES = 10;
const MAX_AIM_ELEVATION_DEGREES = 60;
const MOVE_COMMAND_UNITS_PER_SQUARE = 1;
const MAX_MOVE_COMMAND_UNITS = 10;
const MAX_MOVE_DISTANCE_UNITS = (MAX_MOVE_COMMAND_UNITS / MOVE_COMMAND_UNITS_PER_SQUARE) * UNITS_PER_SQUARE;
const MAX_PROJECTILE_DAMAGE = 35;
const MIN_PROJECTILE_DAMAGE = 4;
const COLLISION_DAMAGE_PER_SPEED = 0.18;
const MAX_COLLISION_DAMAGE = 45;
const NORMAL_IQR_WIDTH_IN_SIGMA = 1.3489795003921634;
const PROJECTILE_DAMAGE_SIGMA = PROJECTILE_HIT_RADIUS_UNITS / NORMAL_IQR_WIDTH_IN_SIGMA;
const LEGACY_DIRECTION_DEGREES = {
  north: 0,
  east: 90,
  south: 180,
  west: 270,
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
  | { action: "bear"; bearing: number }
  | { action: "move"; units: number }
  | { action: "aim"; bearing: number }
  | { action: "elev"; elevation: number }
  | { action: "pow"; power: number }
  | { action: "fire" }
  | { action: "ret" };

type OrderQueueType = "move" | "bearing" | "cannon";

const ORDER_QUEUE_TYPES: OrderQueueType[] = ["move", "bearing", "cannon"];

type CollisionDetails =
  | { type: "none"; position: { x: number; y: number } }
  | { type: "wall"; position: { x: number; y: number }; normal: { x: number; y: number }; penetration: number };

const observedEvent = v.object({
  eventId: v.id("worldEvents"),
  sourcePlayerId: v.id("players"),
  targetTankId: v.optional(v.id("tanks")),
  type: v.union(v.literal("explosion"), v.literal("tankCollision")),
  position: v.object({
    x: v.number(),
    y: v.number(),
  }),
  normal: v.optional(v.object({
    x: v.number(),
    y: v.number(),
  })),
  radius: v.optional(v.number()),
  damage: v.number(),
  penetration: v.optional(v.number()),
  expiresAt: v.number(),
});

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
      .take(2);
    const tanks = await ctx.db
      .query("tanks")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .take(2);
    const projectiles = await ctx.db
      .query("projectiles")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .take(60);
    const events = await ctx.db
      .query("worldEvents")
      .withIndex("by_match_and_expires_at", (q) => q.eq("matchId", match._id).gte("expiresAt", Date.now()))
      .take(40);
    const matchEnd = resolveMatchEnd(players, tanks);
    const finishedAt = matchEnd.finished
      ? tanks
        .filter((tank) => tank.health <= 0)
        .map((tank) => tank.updatedAt)
        .sort((a, b) => a - b)[0]
      : undefined;
    const viewMatch = {
      ...match,
      status: matchEnd.finished ? "finished" : players.length >= 2 ? "active" : match.status,
      ...(matchEnd.winnerPlayerId ? { winnerPlayerId: matchEnd.winnerPlayerId } : {}),
      ...(finishedAt ? { finishedAt } : {}),
    };

    return { match: viewMatch, board, players, tanks, orders: [], projectiles, events };
  },
});

export const listBattles = query({
  args: {
    lobbyId: v.optional(v.string()),
    commanderId: v.optional(v.id("commanderProfiles")),
  },
  returns: v.array(
    v.object({
      _id: v.id("matches"),
      roomCode: v.string(),
      battleName: v.optional(v.string()),
      status: v.union(
        v.literal("lobby"),
        v.literal("active"),
      ),
      currentTick: v.number(),
      playerCount: v.number(),
      maxPlayers: v.number(),
      viewerIsPlayer: v.boolean(),
      createdAt: v.number(),
      updatedAt: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const lobbyId = normalizeLobbyId(args.lobbyId);
    const matches = await ctx.db
      .query("matches")
      .withIndex("by_lobby_and_created_at", (q) => q.eq("lobbyId", lobbyId))
      .order("desc")
      .take(50);

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

      const matchEnd = resolveMatchEnd(players, tanks);
      if (match.status === "finished" || matchEnd.finished) {
        continue;
      }
      const status: "active" | "lobby" = players.length >= 2 ? "active" : "lobby";

      rows.push({
        _id: match._id,
        roomCode: match.roomCode,
        battleName: match.battleName,
        status,
        currentTick: match.currentTick,
        playerCount: players.length,
        maxPlayers: 2,
        viewerIsPlayer: args.commanderId
          ? players.some((player) => player.commanderId === args.commanderId)
          : false,
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
    const battleName = cleanBattleName(args.battleName);
    const existing = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q) => q.eq("roomCode", roomCode))
      .unique();

    if (existing) {
      throw new Error("Battle code already used");
    }

    const matchesWithName = await ctx.db
      .query("matches")
      .withIndex("by_lobby_and_battle_name", (q) => q.eq("lobbyId", DEFAULT_LOBBY_ID).eq("battleName", battleName))
      .take(50);

    for (const matchWithName of matchesWithName) {
      if (matchWithName.status === "finished") {
        continue;
      }
      const tanks = await ctx.db
        .query("tanks")
        .withIndex("by_match", (q) => q.eq("matchId", matchWithName._id))
        .take(2);
      const players = await ctx.db
        .query("players")
        .withIndex("by_match", (q) => q.eq("matchId", matchWithName._id))
        .take(2);

      if (!resolveMatchEnd(players, tanks).finished) {
        throw new Error("Battle already exists");
      }
    }

    const boardId = await ensureDefaultBoard(ctx, now);
    const matchId = await ctx.db.insert("matches", {
      boardId,
      roomCode,
      lobbyId: DEFAULT_LOBBY_ID,
      battleName,
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
      moveRemaining: 0,
      hullDirection: 90,
      turretDirection: 90,
      turretLocked: true,
      tankSpec: commander.tankSpec,
      ammoType: "missile",
      launchAngle: DEFAULT_FIRE_ANGLE_DEGREES,
      cannonPower: DEFAULT_FIRE_POWER,
      lastFirePower: DEFAULT_FIRE_POWER,
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

    if (match.status === "finished") {
      throw new Error("Battle already finished");
    }

    const players = await ctx.db
      .query("players")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .take(3);

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
      moveRemaining: 0,
      hullDirection: slot === "alpha" ? 90 : 270,
      turretDirection: slot === "alpha" ? 90 : 270,
      turretLocked: true,
      tankSpec: commander.tankSpec,
      ammoType: "missile",
      launchAngle: DEFAULT_FIRE_ANGLE_DEGREES,
      cannonPower: DEFAULT_FIRE_POWER,
      lastFirePower: DEFAULT_FIRE_POWER,
      health: MAX_HEALTH,
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

    const commander = await requireCommanderProfile(ctx, args.commanderId);
    const player = await findCommanderPlayer(ctx, match._id, commander.commanderId);
    if (!player) {
      throw new Error("Join the room before submitting orders");
    }

    const tank = await findPlayerTank(ctx, match._id, player._id);
    if (!tank) {
      throw new Error("Tank not found");
    }

    await queuePlayerCommands(ctx, match, player, tank, args.commands, now);
    return null;
  },
});

export const runPlayerTick = mutation({
  args: {
    roomCode: v.string(),
    commanderId: v.id("commanderProfiles"),
    commands: v.array(v.string()),
    observedEvents: v.optional(v.array(observedEvent)),
  },
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

    const commander = await requireCommanderProfile(ctx, args.commanderId);
    const player = await findCommanderPlayer(ctx, match._id, commander.commanderId);
    if (!player) {
      throw new Error("Join the room before advancing battle");
    }

    const tank = await findPlayerTank(ctx, match._id, player._id);
    if (!tank) {
      throw new Error("Tank not found");
    }

    if (args.commands.length > 0) {
      await queuePlayerCommands(ctx, match, player, tank, args.commands, now);
    }

    await advanceSinglePlayerTick(ctx, match, player, args.observedEvents ?? [], now);
    return null;
  },
});

export const runNextTick = mutation({
  args: {
    roomCode: v.string(),
    agentKey: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    const agentKeyHash = args.agentKey ? await sha256(args.agentKey) : null;
    if (!userId && !agentKeyHash) {
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

    let player = null;
    if (agentKeyHash) {
      player = await ctx.db
        .query("players")
        .withIndex("by_match_and_agent_key", (q) => q.eq("matchId", match._id).eq("agentKeyHash", agentKeyHash))
        .unique();
    } else if (userId) {
      player = await ctx.db
        .query("players")
        .withIndex("by_match_and_user", (q) => q.eq("matchId", match._id).eq("userId", userId))
        .first();
    }
    if (!player) {
      return null;
    }

    await advanceSinglePlayerTick(ctx, match, player, [], now);
    return null;
  },
});

async function queuePlayerCommands(ctx: any, match: any, player: any, tank: any, rawCommands: string[], now: number) {
  const commandsByQueue = emptyCommandQueues();
  for (const command of rawCommands) {
    const normalizedCommands = normalizeOrderCommand(command);
    if (normalizedCommands.length === 0) {
      throw new Error("Incorrect command");
    }
    for (const normalizedCommand of normalizedCommands) {
      const parsed = parseStoredCommand(normalizedCommand);
      if (!parsed) {
        throw new Error("Incorrect command");
      }
      commandsByQueue[queueTypeForCommand(parsed)].push(normalizedCommand);
    }
  }

  const queuedCommands = compressCommandQueues(commandsByQueue);
  if (ORDER_QUEUE_TYPES.every((queueType) => queuedCommands[queueType].length === 0)) {
    return;
  }

  const hadMoveCommands = queuedCommands.move.length > 0;
  const activeMoveRemaining = clampFinite(tank.moveRemaining, -MAX_MOVE_DISTANCE_UNITS * 4, MAX_MOVE_DISTANCE_UNITS * 4, 0);
  if (Math.abs(activeMoveRemaining) > 0.5 && hadMoveCommands) {
    const extraDistance = queuedCommands.move.reduce((total, command) => {
      const parsed = parseStoredCommand(command);
      return parsed?.action === "move" ? total + moveCommandUnitsToDistance(parsed.units) : total;
    }, 0);
    await ctx.db.patch(tank._id, {
      moveRemaining: activeMoveRemaining + extraDistance,
      updatedAt: now,
    });
    queuedCommands.move = [];
  }

  if (hadMoveCommands || queuedCommands.bearing.length > 0 || queuedCommands.cannon.length > 0) {
    const existingOrders = await ctx.db
      .query("orders")
      .withIndex("by_player", (q: any) => q.eq("playerId", player._id))
      .take(50);

    if (hadMoveCommands) {
      await completeActiveOrdersForQueue(ctx, existingOrders, tank._id, "move", now);
    }
    if (queuedCommands.bearing.length > 0) {
      await completeActiveOrdersForQueue(ctx, existingOrders, tank._id, "bearing", now);
    }
    if (queuedCommands.cannon.length > 0) {
      await completeActiveOrdersForQueue(ctx, existingOrders, tank._id, "cannon", now);
    }
  }

  for (const queueType of ORDER_QUEUE_TYPES) {
    const commands = queuedCommands[queueType];
    if (commands.length === 0) {
      continue;
    }

    await ctx.db.insert("orders", {
      matchId: match._id,
      playerId: player._id,
      tankId: tank._id,
      queueType,
      commands,
      cursor: 0,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function advanceSinglePlayerTick(ctx: any, match: any, player: any, observedEvents: any[], now: number) {
  if (now - (player.lastTickAt ?? 0) < MIN_TICK_INTERVAL_MS) {
    return;
  }

  const board = await ctx.db.get(match.boardId);
  if (!board) {
    return;
  }

  const tank = await findPlayerTank(ctx, match._id, player._id);
  if (!tank) {
    await cleanupExpiredOwnedRows(ctx, player._id, now);
    await ctx.db.patch(player._id, { lastTickAt: now });
    return;
  }

  const orders = await ctx.db
    .query("orders")
    .withIndex("by_player", (q: any) => q.eq("playerId", player._id))
    .take(50);

  let latestTank = await ctx.db.get(tank._id);
  if (latestTank && observedEvents.length > 0) {
    await applyObservedEventsToTank(ctx, match, board, player, latestTank, orders, observedEvents, now);
    latestTank = await ctx.db.get(tank._id);
  }

  if (latestTank && latestTank.health > 0) {
    for (const queueType of ORDER_QUEUE_TYPES) {
      latestTank = await ctx.db.get(tank._id);
      if (!latestTank || latestTank.health <= 0) {
        break;
      }

      const order = activeOrderForQueue(orders, latestTank._id, queueType);
      const command = order ? order.commands[order.cursor] : undefined;
      const commandComplete = await applyCommand(
        ctx,
        board,
        latestTank,
        command,
        order ? `${order._id}:${order.cursor}` : undefined,
        now,
      );

      if (order && commandComplete) {
        const cursor = order.cursor + 1;
        await ctx.db.patch(order._id, {
          cursor,
          status: cursor >= order.commands.length ? "complete" : "running",
          updatedAt: now,
        });
      }
    }

    const tankAfterCommands = await ctx.db.get(tank._id);
    if (tankAfterCommands) {
      await advanceTankMotion(ctx, board, orders, tankAfterCommands, player.lastTickAt ?? 0, now);
      const tankAfterMotion = await ctx.db.get(tank._id);
      latestTank = tankAfterMotion ?? tankAfterCommands;
    }
  }

  if (latestTank) {
    await advanceOwnedProjectiles(ctx, board.size, latestTank, now);
  }

  await cleanupExpiredOwnedRows(ctx, player._id, now);

  const playerPatch: any = { lastTickAt: now };
  const finalTank = latestTank ? await ctx.db.get(latestTank._id) : null;
  if (finalTank && finalTank.health <= 0 && !player.finishedAt) {
    playerPatch.finishedAt = now;
  }
  await ctx.db.patch(player._id, playerPatch);
}

async function findCommanderPlayer(ctx: any, matchId: any, commanderId: any) {
  return await ctx.db
    .query("players")
    .withIndex("by_match_and_commander", (q: any) => q.eq("matchId", matchId).eq("commanderId", commanderId))
    .unique();
}

async function findPlayerTank(ctx: any, matchId: any, playerId: any) {
  const tank = await ctx.db
    .query("tanks")
    .withIndex("by_player", (q: any) => q.eq("playerId", playerId))
    .unique();
  return tank && tank.matchId === matchId ? tank : null;
}

async function ensureDefaultBoard(ctx: any, now: number) {
  const existing = await ctx.db
    .query("boards")
    .withIndex("by_code", (q: any) => q.eq("code", "classic"))
    .unique();

  if (existing) {
    return existing._id;
  }

  const walls: { x: number; y: number }[] = [];
  for (let index = 0; index < BOARD_SIZE; index += 1) {
    appendWall(walls, { x: index, y: 0 });
    appendWall(walls, { x: index, y: BOARD_SIZE - 1 });
    appendWall(walls, { x: 0, y: index });
    appendWall(walls, { x: BOARD_SIZE - 1, y: index });
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

async function applyCommand(
  ctx: any,
  board: any,
  tank: any,
  command: string | undefined,
  commandKey: string | undefined,
  now: number,
) {
  if (tank.health <= 0 || !command) {
    return true;
  }

  const parsed = parseStoredCommand(command);
  if (!parsed) {
    return true;
  }

  if (parsed.action === "bear") {
    const result = stepTowardBearing(angleFromDirection(tank.hullDirection), parsed.bearing);
    await patchHullBearing(ctx, tank, result.bearing, now);
    return result.complete;
  }

  if (parsed.action === "aim") {
    const result = stepTowardBearing(angleFromDirection(tank.turretDirection), parsed.bearing);
    await ctx.db.patch(tank._id, {
      turretDirection: result.bearing,
      turretLocked: false,
      updatedAt: now,
    });
    return result.complete;
  }

  if (parsed.action === "elev") {
    await ctx.db.patch(tank._id, {
      launchAngle: parsed.elevation,
      updatedAt: now,
    });
    return true;
  }

  if (parsed.action === "pow") {
    await ctx.db.patch(tank._id, {
      cannonPower: parsed.power,
      lastFirePower: parsed.power,
      updatedAt: now,
    });
    return true;
  }

  if (parsed.action === "ret") {
    const result = stepTowardBearing(angleFromDirection(tank.turretDirection), angleFromDirection(tank.hullDirection));
    await ctx.db.patch(tank._id, {
      turretDirection: result.bearing,
      turretLocked: result.complete,
      updatedAt: now,
    });
    return result.complete;
  }

  if (parsed.action === "move") {
    const remaining = clampFinite(tank.moveRemaining, -MAX_MOVE_DISTANCE_UNITS * 4, MAX_MOVE_DISTANCE_UNITS * 4, 0);
    if (tank.activeMoveCommand === commandKey && Math.abs(remaining) <= 0.5) {
      await ctx.db.patch(tank._id, {
        speed: 0,
        velocity: { x: 0, y: 0 },
        updatedAt: now,
      });
      return true;
    }

    if (tank.activeMoveCommand !== commandKey) {
      await ctx.db.patch(tank._id, {
        activeMoveCommand: commandKey ?? command,
        moveRemaining: remaining + moveCommandUnitsToDistance(parsed.units),
        updatedAt: now,
      });
    }
    return false;
  }

  if (parsed.action === "fire") {
    const power = clampFinite(tank.cannonPower ?? tank.lastFirePower, MIN_FIRE_POWER, MAX_FIRE_POWER, DEFAULT_FIRE_POWER);
    const launch = launchVelocity(power, tank.launchAngle ?? DEFAULT_FIRE_ANGLE_DEGREES);
    const muzzleVelocity = vectorFromBearing(angleFromDirection(tank.turretDirection), launch.horizontal);
    const velocity = addVectors(muzzleVelocity, tank.velocity ?? { x: 0, y: 0 });
    const tankSpec = normalizeTankSpec(tank.tankSpec);
    const mountOffset = vectorFromBearing(
      angleFromDirection(tank.hullDirection),
      (tankSpec.turretOffset - 0.5) * TANK_LENGTH_UNITS,
    );
    const barrelVector = vectorFromBearing(
      angleFromDirection(tank.turretDirection),
      (tankSpec.turretSize * TANK_WIDTH_UNITS) / 2 + tankSpec.cannonLength * TANK_LENGTH_UNITS,
    );
    const muzzle = {
      x: tank.position.x + mountOffset.x + barrelVector.x,
      y: tank.position.y + mountOffset.y + barrelVector.y,
    };
    await ctx.db.insert("projectiles", {
      matchId: tank.matchId,
      ownerPlayerId: tank.playerId,
      ownerTankId: tank._id,
      position: clampProjectilePosition(muzzle, board.size),
      velocity,
      damage: MAX_PROJECTILE_DAMAGE,
      height: 0,
      verticalVelocity: launch.vertical,
      launchPower: power,
      launchAngle: tank.launchAngle ?? DEFAULT_FIRE_ANGLE_DEGREES,
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(tank._id, { lastFirePower: power, updatedAt: now });
    return true;
  }

  return true;
}

async function advanceOwnedProjectiles(ctx: any, boardSize: number, ownerTank: any, now: number) {
  const projectiles = await ctx.db
    .query("projectiles")
    .withIndex("by_owner_player", (q: any) => q.eq("ownerPlayerId", ownerTank.playerId))
    .take(30);

  for (const projectile of projectiles.filter((item: any) => item.ownerTankId === ownerTank._id && (item.status === "active" || item.status === "exploding"))) {
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

    if (hitsWall || hitsGround) {
      await createExplosionWorldEvent(ctx, ownerTank, projectile, clampProjectilePosition(nextPosition, boardSize), now);
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
}

function resolveMatchEnd(players: any[], tanks: any[]) {
  if (players.length < 2) {
    return { finished: false, winnerPlayerId: undefined };
  }

  const alivePlayerIds = new Set(
    tanks
      .filter((tank) => tank.health > 0)
      .map((tank) => tank.playerId),
  );

  if (alivePlayerIds.size > 1) {
    return { finished: false, winnerPlayerId: undefined };
  }

  const [winnerPlayerId] = Array.from(alivePlayerIds);
  return {
    finished: true,
    winnerPlayerId,
  };
}

async function advanceTankMotion(ctx: any, board: any, orders: any[], tank: any, tick: number, now: number) {
  if (tank.health <= 0) {
    return false;
  }

  const moveRemaining = clampFinite(tank.moveRemaining, -MAX_MOVE_DISTANCE_UNITS * 4, MAX_MOVE_DISTANCE_UNITS * 4, 0);
  const currentSpeed = vectorLength(tank.velocity ?? { x: 0, y: 0 });
  const remainingMagnitude = Math.abs(moveRemaining);
  if (remainingMagnitude <= 0.5 && currentSpeed <= 0.5) {
    return false;
  }

  const nextSpeed = nextMovementSpeed(currentSpeed, remainingMagnitude);
  const moveSign = moveRemaining < 0 ? -1 : 1;
  const velocity = vectorFromBearing(angleFromDirection(tank.hullDirection), nextSpeed * moveSign);
  const travelDistance = Math.min(nextSpeed, remainingMagnitude);
  const nextMoveRemaining = moveRemaining - moveSign * travelDistance;
  const travelVector = normalizedVector(velocity, { x: 0, y: -1 });
  const desiredPosition = {
    x: tank.position.x + travelVector.x * travelDistance,
    y: tank.position.y + travelVector.y * travelDistance,
  };
  const move = resolveTankMove(desiredPosition, board, velocity);

  if (move.type === "none") {
    await ctx.db.patch(tank._id, {
      position: move.position,
      velocity,
      speed: vectorLength(velocity),
      moveRemaining: Math.abs(nextMoveRemaining) <= 0.5 ? 0 : nextMoveRemaining,
      updatedAt: now,
    });
    return false;
  }

  const impactSpeed = collisionImpactSpeed(velocity, move);
  if (impactSpeed <= 0.5) {
    await ctx.db.patch(tank._id, {
      position: move.position,
      velocity,
      speed: vectorLength(velocity),
      moveRemaining: Math.abs(nextMoveRemaining) <= 0.5 ? 0 : nextMoveRemaining,
      updatedAt: now,
    });
    return false;
  }

  const reboundVelocity = scaleVector(reflectVector(velocity, move.normal), REBOUND_SPEED_SCALE);
  const reboundPosition = clampPosition(addVectors(tank.position, scaleVector(normalizedVector(reboundVelocity, move.normal), Math.max(move.penetration + 12, 36))), board.size);
  const damage = collisionDamageForImpact(impactSpeed);
  const movingHealth = Math.max(0, tank.health - damage);
  await ctx.db.patch(tank._id, {
    position: reboundPosition,
    velocity: { x: 0, y: 0 },
    speed: 0,
    moveRemaining: 0,
    activeMoveCommand: "",
    health: movingHealth,
    updatedAt: now,
  });

  await abortTankOrders(ctx, orders, [tank._id], now);

  const collisionEvent: any = {
    matchId: tank.matchId,
    ownerPlayerId: tank.playerId,
    tankId: tank._id,
    type: move.type,
    position: move.position,
    normal: move.normal,
    impactSpeed,
    damageToTank: damage,
    tick,
    createdAt: now,
  };
  await ctx.db.insert("collisionEvents", collisionEvent);

  return movingHealth <= 0;
}

async function createExplosionWorldEvent(ctx: any, ownerTank: any, projectile: any, position: { x: number; y: number }, now: number) {
  const existing = await ctx.db
    .query("worldEvents")
    .withIndex("by_projectile", (q: any) => q.eq("projectileId", projectile._id))
    .first();
  if (existing) {
    return;
  }

  await ctx.db.insert("worldEvents", {
    matchId: ownerTank.matchId,
    sourcePlayerId: ownerTank.playerId,
    sourceTankId: ownerTank._id,
    projectileId: projectile._id,
    type: "explosion",
    position,
    radius: PROJECTILE_HIT_RADIUS_UNITS,
    damage: projectile.damage,
    createdAt: now,
    expiresAt: now + WORLD_EVENT_TTL_MS,
  });
}

async function applyObservedEventsToTank(ctx: any, match: any, board: any, player: any, tank: any, orders: any[], observedEvents: any[], now: number) {
  let currentTank = tank;
  for (const event of observedEvents.slice(0, 20)) {
    currentTank = await ctx.db.get(currentTank._id);
    if (!currentTank || currentTank.health <= 0) {
      return;
    }

    if (event.sourcePlayerId === player._id || event.expiresAt <= now) {
      continue;
    }

    const alreadyApplied = await ctx.db
      .query("worldEventApplications")
      .withIndex("by_player_and_event", (q: any) => q.eq("playerId", player._id).eq("eventId", event.eventId))
      .unique();
    if (alreadyApplied) {
      continue;
    }

    if (event.type === "explosion") {
      const radius = event.radius ?? PROJECTILE_HIT_RADIUS_UNITS;
      const impactDistance = distanceBetween(currentTank.position, event.position);
      if (impactDistance > radius) {
        continue;
      }

      const damage = damageForImpact(impactDistance, event.damage);
      const velocity = scaleVector(currentTank.velocity ?? { x: 0, y: 0 }, 0.5);
      await ctx.db.patch(currentTank._id, {
        health: Math.max(0, currentTank.health - damage),
        velocity,
        speed: vectorLength(velocity),
        updatedAt: now,
      });
      await ctx.db.insert("worldEventApplications", {
        matchId: match._id,
        playerId: player._id,
        eventId: event.eventId,
        tankId: currentTank._id,
        createdAt: now,
      });
      continue;
    }

    if (event.type === "tankCollision" && event.targetTankId === currentTank._id) {
      const normal = event.normal ?? normalizedVector(subtractVectors(currentTank.position, event.position), { x: 1, y: 0 });
      await ctx.db.patch(currentTank._id, {
        position: clampPosition(addVectors(currentTank.position, scaleVector(normal, -Math.max((event.penetration ?? 0) + 12, 36))), board.size),
        velocity: { x: 0, y: 0 },
        speed: 0,
        moveRemaining: 0,
        activeMoveCommand: "",
        health: Math.max(0, currentTank.health - event.damage),
        updatedAt: now,
      });
      await abortTankOrders(ctx, orders, [currentTank._id], now);
      await ctx.db.insert("worldEventApplications", {
        matchId: match._id,
        playerId: player._id,
        eventId: event.eventId,
        tankId: currentTank._id,
        createdAt: now,
      });
    }
  }
}

async function cleanupExpiredOwnedRows(ctx: any, playerId: any, now: number) {
  const events = await ctx.db
    .query("worldEvents")
    .withIndex("by_source_player_and_expires_at", (q: any) => q.eq("sourcePlayerId", playerId).gte("expiresAt", now - WORLD_EVENT_CLEANUP_WINDOW_MS).lte("expiresAt", now))
    .take(20);

  for (const event of events) {
    await ctx.db.delete(event._id);
  }

  const applications = await ctx.db
    .query("worldEventApplications")
    .withIndex("by_player_and_created_at", (q: any) => q.eq("playerId", playerId).gte("createdAt", now - WORLD_EVENT_CLEANUP_WINDOW_MS).lte("createdAt", now - WORLD_EVENT_TTL_MS))
    .take(20);

  for (const application of applications) {
    await ctx.db.delete(application._id);
  }

  const collisions = await ctx.db
    .query("collisionEvents")
    .withIndex("by_owner_player_and_created_at", (q: any) => q.eq("ownerPlayerId", playerId).gte("createdAt", now - WORLD_EVENT_CLEANUP_WINDOW_MS).lte("createdAt", now - WORLD_EVENT_TTL_MS))
    .take(20);

  for (const collision of collisions) {
    await ctx.db.delete(collision._id);
  }
}

async function abortTankOrders(ctx: any, orders: any[], tankIds: any[], now: number) {
  const tankIdsToAbort = new Set(tankIds);
  for (const order of orders) {
    if (!tankIdsToAbort.has(order.tankId) || order.status === "complete") {
      continue;
    }
    await ctx.db.patch(order._id, {
      cursor: order.commands.length,
      status: "complete",
      updatedAt: now,
    });
  }
}

async function completeActiveOrdersForQueue(
  ctx: any,
  orders: any[],
  tankId: any,
  queueType: OrderQueueType,
  now: number,
) {
  for (const order of orders) {
    if (order.tankId !== tankId || order.status === "complete" || orderQueueType(order) !== queueType) {
      continue;
    }

    await ctx.db.patch(order._id, {
      cursor: order.commands.length,
      status: "complete",
      updatedAt: now,
    });
  }
}

function activeOrderForQueue(orders: any[], tankId: any, queueType: OrderQueueType) {
  return orders
    .filter((order) => order.tankId === tankId && order.status !== "complete" && orderQueueType(order) === queueType)
    .sort((left, right) => (left.createdAt ?? left._creationTime ?? 0) - (right.createdAt ?? right._creationTime ?? 0))[0];
}

function orderQueueType(order: any): OrderQueueType {
  if (order.queueType === "move" || order.queueType === "bearing" || order.queueType === "cannon") {
    return order.queueType;
  }

  const command = order.commands[order.cursor] ?? order.commands[0];
  const parsed = command ? parseStoredCommand(command) : null;
  return parsed ? queueTypeForCommand(parsed) : "cannon";
}

function normalizeRoom(roomCode: string) {
  return roomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "Room";
}

function appendWall(walls: { x: number; y: number }[], wall: { x: number; y: number }) {
  if (!walls.some((candidate) => candidate.x === wall.x && candidate.y === wall.y)) {
    walls.push(wall);
  }
}

function normalizeLobbyId(lobbyId: string | undefined) {
  return lobbyId?.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || DEFAULT_LOBBY_ID;
}

function cleanBattleName(name: string | undefined) {
  return name?.trim().slice(0, 48) || "Battle";
}

function emptyCommandQueues() {
  return {
    move: [],
    bearing: [],
    cannon: [],
  } as Record<OrderQueueType, string[]>;
}

function compressCommandQueues(commandsByQueue: Record<OrderQueueType, string[]>) {
  return {
    move: compressMoveCommands(commandsByQueue.move),
    bearing: compressBearingCommands(commandsByQueue.bearing),
    cannon: compressCannonCommands(commandsByQueue.cannon),
  } as Record<OrderQueueType, string[]>;
}

function compressMoveCommands(commands: string[]) {
  return commands;
}

function compressBearingCommands(commands: string[]) {
  const lastCommand = commands.at(-1);
  return lastCommand ? [lastCommand] : [];
}

function compressCannonCommands(commands: string[]) {
  const compressed: string[] = [];
  const pending: Partial<Record<"aim" | "elev" | "pow" | "ret", string>> = {};

  const flushPending = () => {
    for (const action of ["aim", "ret", "elev", "pow"] as const) {
      const command = pending[action];
      if (command) {
        compressed.push(command);
        delete pending[action];
      }
    }
  };

  for (const command of commands) {
    const parsed = parseStoredCommand(command);
    if (!parsed) {
      continue;
    }

    if (parsed.action === "fire") {
      flushPending();
      compressed.push(command);
      continue;
    }

    if (parsed.action === "aim" || parsed.action === "ret") {
      delete pending.aim;
      delete pending.ret;
      pending[parsed.action] = command;
      continue;
    }

    if (parsed.action === "elev" || parsed.action === "pow") {
      pending[parsed.action] = command;
    }
  }

  flushPending();
  return compressed;
}

function queueTypeForCommand(command: StoredCommand): OrderQueueType {
  if (command.action === "move") {
    return "move";
  }
  if (command.action === "bear") {
    return "bearing";
  }
  return "cannon";
}

function normalizeOrderCommand(command: string): string[] {
  if (/[;,\n]/.test(command)) {
    return command.split(/[;,\n]+/).flatMap(normalizeOrderCommand);
  }

  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  const parsed = parseInputCommand(normalized);
  if (!parsed) {
    return [];
  }
  return [serializeCommand(parsed)];
}

function parseInputCommand(command: string): StoredCommand | null {
  const parsed = parseStoredCommand(command);
  if (!parsed) {
    return null;
  }

  if (parsed.action === "bear" || parsed.action === "aim") {
    const [, rawAmount] = command.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
    const bearing = strictHeading(rawAmount);
    return bearing === null ? null : { action: parsed.action, bearing: roundForStorage(bearing) };
  }

  return parsed;
}

function parseStoredCommand(command: string): StoredCommand | null {
  const [rawAction, rawAmount, rawSecondAmount, extra] = command.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
  const action = expandCommandAction(rawAction);
  if (extra !== undefined) {
    return null;
  }

  if (action === "bear") {
    const bearing = strictNumber(rawAmount, 0, 360);
    if (bearing === null || rawSecondAmount !== undefined) {
      return null;
    }

    return { action, bearing: roundForStorage(normalizeDegrees(bearing)) };
  }

  if (action === "move") {
    const units = strictNumber(rawAmount, -MAX_MOVE_COMMAND_UNITS, MAX_MOVE_COMMAND_UNITS);
    if (units === null || rawSecondAmount !== undefined) {
      return null;
    }

    return { action, units: roundForStorage(units) };
  }

  if (action === "aim") {
    const bearing = strictNumber(rawAmount, 0, 360);
    if (bearing === null || rawSecondAmount !== undefined) {
      return null;
    }

    return { action, bearing: roundForStorage(normalizeDegrees(bearing)) };
  }

  if (action === "elev") {
    const elevation = strictNumber(rawAmount, MIN_AIM_ELEVATION_DEGREES, MAX_AIM_ELEVATION_DEGREES);
    if (elevation === null || rawSecondAmount !== undefined) {
      return null;
    }

    return { action, elevation: roundForStorage(elevation) };
  }

  if (action === "pow") {
    const power = strictNumber(rawAmount, MIN_FIRE_POWER, MAX_FIRE_POWER);
    if (power === null || rawSecondAmount !== undefined) {
      return null;
    }

    return { action, power: roundForStorage(power) };
  }

  if (action === "fire") {
    if (rawAmount !== undefined || rawSecondAmount !== undefined) {
      return null;
    }

    return { action };
  }

  if (action === "ret") {
    if (rawAmount !== undefined || rawSecondAmount !== undefined) {
      return null;
    }

    return { action };
  }

  return null;
}

function expandCommandAction(action: string | undefined) {
  if (action === "b") {
    return "bear";
  }
  if (action === "m") {
    return "move";
  }
  if (action === "a") {
    return "aim";
  }
  if (action === "e") {
    return "elev";
  }
  if (action === "p") {
    return "pow";
  }
  if (action === "f") {
    return "fire";
  }
  if (action === "r") {
    return "ret";
  }
  return action;
}

function serializeCommand(command: StoredCommand) {
  if (command.action === "bear") {
    return `bear ${roundForStorage(command.bearing)}`;
  }
  if (command.action === "move") {
    return `move ${roundForStorage(command.units)}`;
  }
  if (command.action === "aim") {
    return `aim ${roundForStorage(command.bearing)}`;
  }
  if (command.action === "elev") {
    return `elev ${roundForStorage(command.elevation)}`;
  }
  if (command.action === "pow") {
    return `pow ${roundForStorage(command.power)}`;
  }
  if (command.action === "ret") {
    return command.action;
  }
  return "fire";
}

function strictNumber(rawAmount: string | undefined, min: number, max: number) {
  if (rawAmount === undefined) {
    return null;
  }

  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount < min || amount > max) {
    return null;
  }
  return amount;
}

function strictHeading(rawAmount: string | undefined) {
  const heading = strictNumber(rawAmount, 0, 36);
  return heading === null ? null : normalizeDegrees(heading * 10);
}

function vectorFromBearing(degrees: number, magnitude: number) {
  const radians = ((normalizeDegrees(degrees) - 90) * Math.PI) / 180;
  return {
    x: Math.cos(radians) * magnitude,
    y: Math.sin(radians) * magnitude,
  };
}

function moveCommandUnitsToDistance(units: number) {
  return (units / MOVE_COMMAND_UNITS_PER_SQUARE) * UNITS_PER_SQUARE;
}

async function patchHullBearing(ctx: any, tank: any, hullDirection: number, now: number) {
  const delta = shortestAngleDelta(angleFromDirection(tank.hullDirection), hullDirection);
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

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function shortestAngleDelta(from: number, to: number) {
  return ((normalizeDegrees(to) - normalizeDegrees(from) + 540) % 360) - 180;
}

function stepTowardBearing(current: number, target: number) {
  const delta = shortestAngleDelta(current, target);
  if (Math.abs(delta) <= ROTATION_DEGREES_PER_TICK) {
    return { bearing: normalizeDegrees(target), complete: true };
  }

  return {
    bearing: normalizeDegrees(current + Math.sign(delta) * ROTATION_DEGREES_PER_TICK),
    complete: false,
  };
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

function nextMovementSpeed(currentSpeed: number, remainingDistance: number) {
  if (remainingDistance <= 0.5) {
    return Math.max(0, currentSpeed - ACCELERATION_UNITS_PER_TICK);
  }

  const stoppingDistance = (currentSpeed * currentSpeed) / (2 * ACCELERATION_UNITS_PER_TICK);
  if (stoppingDistance >= remainingDistance) {
    return Math.max(0, currentSpeed - ACCELERATION_UNITS_PER_TICK);
  }

  return Math.min(MAX_SPEED_UNITS_PER_TICK, currentSpeed + ACCELERATION_UNITS_PER_TICK);
}

function clampPosition(position: { x: number; y: number }, boardSize: number) {
  const min = UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS;
  const max = boardSize * UNITS_PER_SQUARE - UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS;
  return {
    x: clamp(position.x, min, max),
    y: clamp(position.y, min, max),
  };
}

function resolveTankMove(
  position: { x: number; y: number },
  board: any,
  velocity: { x: number; y: number },
): CollisionDetails {
  const nextPosition = clampPosition(position, board.size);
  const clampDelta = subtractVectors(nextPosition, position);
  const wallCollision = findWallCollision(nextPosition, board.walls) ?? (
    vectorLength(clampDelta) > 0.001
      ? {
        normal: normalizedVector(clampDelta, { x: 0, y: 0 }),
        penetration: vectorLength(clampDelta),
      }
      : null
  );
  if (wallCollision && dotProduct(velocity, wallCollision.normal) < -0.01) {
    return {
      type: "wall",
      position: nextPosition,
      normal: wallCollision.normal,
      penetration: wallCollision.penetration,
    };
  }

  return {
    type: "none",
    position: nextPosition,
  };
}

function findWallCollision(position: { x: number; y: number }, walls: { x: number; y: number }[]) {
  return walls
    .map((wall) => circleCellCollision(position, wall))
    .filter((collision): collision is { normal: { x: number; y: number }; penetration: number } => Boolean(collision))
    .sort((a, b) => b.penetration - a.penetration)[0] ?? null;
}

function circleCellCollision(center: { x: number; y: number }, cell: { x: number; y: number }) {
  const minX = cell.x * UNITS_PER_SQUARE;
  const minY = cell.y * UNITS_PER_SQUARE;
  const maxX = minX + UNITS_PER_SQUARE;
  const maxY = minY + UNITS_PER_SQUARE;
  const closestX = clamp(center.x, minX, maxX);
  const closestY = clamp(center.y, minY, maxY);
  const closestPoint = { x: closestX, y: closestY };
  const distance = distanceBetween(center, closestPoint);
  if (distance >= TANK_COLLISION_RADIUS_UNITS) {
    return null;
  }

  return {
    normal: normalizedVector(subtractVectors(center, closestPoint), wallNormalFromCell(cell)),
    penetration: TANK_COLLISION_RADIUS_UNITS - distance,
  };
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

function addVectors(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtractVectors(a: { x: number; y: number }, b: { x: number; y: number }) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scaleVector(vector: { x: number; y: number }, scale: number) {
  return { x: vector.x * scale, y: vector.y * scale };
}

function dotProduct(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x * b.x + a.y * b.y;
}

function vectorLength(vector: { x: number; y: number }) {
  return Math.hypot(vector.x, vector.y);
}

async function sha256(value: string) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedVector(vector: { x: number; y: number }, fallback: { x: number; y: number }) {
  const length = vectorLength(vector);
  if (length <= 0.0001) {
    return fallback;
  }

  return { x: vector.x / length, y: vector.y / length };
}

function reflectVector(velocity: { x: number; y: number }, normal: { x: number; y: number }) {
  const impact = dotProduct(velocity, normal);
  return subtractVectors(velocity, scaleVector(normal, 2 * impact));
}

function collisionImpactSpeed(velocity: { x: number; y: number }, collision: CollisionDetails) {
  if (collision.type === "none") {
    return 0;
  }

  return Math.max(0, -dotProduct(velocity, collision.normal));
}

function collisionDamageForImpact(impactSpeed: number) {
  if (impactSpeed <= 0) {
    return 0;
  }

  return clamp(Math.round((impactSpeed / MAX_SPEED_UNITS_PER_TICK) * MAX_COLLISION_DAMAGE * COLLISION_DAMAGE_PER_SPEED), 1, MAX_COLLISION_DAMAGE);
}

function wallNormalFromCell(cell: { x: number; y: number }) {
  if (cell.y === 0) {
    return { x: 0, y: 1 };
  }
  if (cell.y === BOARD_SIZE - 1) {
    return { x: 0, y: -1 };
  }
  if (cell.x === 0) {
    return { x: 1, y: 0 };
  }
  return { x: -1, y: 0 };
}

function damageForImpact(distanceFromCenter: number, peakDamage: number) {
  if (distanceFromCenter > PROJECTILE_HIT_RADIUS_UNITS) {
    return 0;
  }

  const gaussian = Math.exp(-0.5 * (distanceFromCenter / PROJECTILE_DAMAGE_SIGMA) ** 2);
  return clamp(Math.round(peakDamage * gaussian), MIN_PROJECTILE_DAMAGE, peakDamage);
}

function launchVelocity(power: number, angle: number) {
  const launchAngle = clamp(angle, MIN_AIM_ELEVATION_DEGREES, MAX_AIM_ELEVATION_DEGREES);
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
    return LAUNCH_RANGE_BY_ANGLE[30];
  }
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
