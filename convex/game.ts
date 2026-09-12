import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import {
  BOARD_SIZE,
  DEFAULT_FIRE_ANGLE_DEGREES,
  DEFAULT_FIRE_POWER,
  DEFAULT_LOBBY_ID,
  FRAME_RATE,
  MAX_FIRE_POWER,
  MAX_HEALTH,
  MAX_AIM_ELEVATION_DEGREES,
  MAX_MOVE_DISTANCE_UNITS,
  MIN_FIRE_POWER,
  MIN_AIM_ELEVATION_DEGREES,
  ORDER_QUEUE_TYPES,
  TANK_COLLISION_RADIUS_UNITS,
  TANK_LENGTH_UNITS,
  TANK_WIDTH_UNITS,
  UNITS_PER_SQUARE,
  addVectors,
  angleFromDirection,
  cleanBattleName,
  clamp,
  clampFinite,
  compressCommandQueues,
  completeActiveOrdersForQueue,
  distanceBetween,
  dotProduct,
  emptyCommandQueues,
  moveCommandUnitsToDistance,
  normalizeDegrees,
  normalizeLobbyId,
  normalizeOrderCommand,
  normalizeRoom,
  normalizeTankSpec,
  normalizedVector,
  orderQueueType,
  parseStoredCommand,
  queueTypeForCommand,
  reflectVector,
  scaleVector,
  sha256,
  shortestAngleDelta,
  spawnPoint,
  subtractVectors,
  tankSpecFromSeed,
  vectorFromBearing,
  vectorLength,
  type OrderQueueType,
} from "./gameCore";

const PROJECTILE_HIT_RADIUS_UNITS = 750;
const PROJECTILE_GRAVITY_UNITS = 48;
const EXPLOSION_DURATION_MS = 1000;
const WORLD_EVENT_TTL_MS = 5000;
const WORLD_EVENT_CLEANUP_WINDOW_MS = 60_000;
const MIN_TICK_INTERVAL_MS = 35;
const TIMELINE_PLAYBACK_DELAY_MS = 350;
const ROTATION_DEGREES_PER_TICK = 360 / (3 * FRAME_RATE);
const MAX_SPEED_UNITS_PER_TICK = (3 * UNITS_PER_SQUARE) / FRAME_RATE;
const ACCELERATION_UNITS_PER_TICK = MAX_SPEED_UNITS_PER_TICK / (FRAME_RATE * 0.8);
const REBOUND_SPEED_SCALE = 0.42;
const MAX_PROJECTILE_DAMAGE = 35;
const MIN_PROJECTILE_DAMAGE = 4;
const COLLISION_DAMAGE_PER_SPEED = 0.18;
const MAX_COLLISION_DAMAGE = 45;
const NORMAL_IQR_WIDTH_IN_SIGMA = 1.3489795003921634;
const PROJECTILE_DAMAGE_SIGMA = PROJECTILE_HIT_RADIUS_UNITS / NORMAL_IQR_WIDTH_IN_SIGMA;
const LAUNCH_RANGE_BY_ANGLE: Record<number, number> = {
  30: 8 * UNITS_PER_SQUARE,
  45: 6 * UNITS_PER_SQUARE,
  60: 4 * UNITS_PER_SQUARE,
};
const tankSpecValidator = v.object({
  hullColor: v.string(),
  turretOffset: v.number(),
  cannonLength: v.number(),
  turretSize: v.number(),
});

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

const vectorInput = v.object({
  x: v.number(),
  y: v.number(),
});

const tankCheckpoint = v.object({
  tankId: v.id("tanks"),
  position: vectorInput,
  velocity: vectorInput,
  speed: v.optional(v.number()),
  moveRemaining: v.optional(v.number()),
  activeMoveCommand: v.optional(v.string()),
  hullDirection: v.number(),
  turretDirection: v.number(),
  turretLocked: v.optional(v.boolean()),
  launchAngle: v.optional(v.number()),
  cannonPower: v.optional(v.number()),
  lastFirePower: v.optional(v.number()),
  health: v.number(),
  updatedAt: v.number(),
});

const queueTypeInput = v.union(v.literal("move"), v.literal("bearing"), v.literal("cannon"));

const nextCommandInput = v.object({
  clientCommandId: v.string(),
  queueType: queueTypeInput,
  command: v.string(),
});

const worldEventInput = v.object({
  clientEventId: v.string(),
  sourceTankId: v.id("tanks"),
  targetTankId: v.optional(v.id("tanks")),
  type: v.union(v.literal("explosion"), v.literal("tankCollision")),
  position: vectorInput,
  normal: v.optional(vectorInput),
  radius: v.optional(v.number()),
  damage: v.number(),
  impactSpeed: v.optional(v.number()),
  penetration: v.optional(v.number()),
  expiresAt: v.number(),
});

export const getRoom = query({
  args: {
    roomCode: v.string(),
    commanderId: v.optional(v.id("commanderProfiles")),
  },
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
    const commandBatches = (await ctx.db
      .query("playerCommands")
      .withIndex("by_match_and_created_at", (q) => q.eq("matchId", match._id))
      .order("desc")
      .take(250)).reverse();
    const now = Date.now();
    const commandTimelines = (await ctx.db
      .query("commandTimelines")
      .withIndex("by_match_and_ended_at", (q) => q.eq("matchId", match._id).gte("endedAt", now - 5_000))
      .take(120));
    const events = await ctx.db
      .query("worldEvents")
      .withIndex("by_match_and_expires_at", (q) => q.eq("matchId", match._id).gte("expiresAt", now))
      .take(40);
    const viewerPlayer = args.commanderId
      ? players.find((player) => player.commanderId === args.commanderId)
      : null;
    const appliedEventIds = new Set(
      viewerPlayer
        ? (await ctx.db
          .query("worldEventApplications")
          .withIndex("by_player_and_created_at", (q) => q.eq("playerId", viewerPlayer._id).gte("createdAt", now - WORLD_EVENT_TTL_MS))
          .take(80))
          .map((application) => application.eventId)
        : [],
    );
    const visibleEvents = events.filter((event) => !appliedEventIds.has(event._id));
    const matchEnd = resolveMatchEnd(players, tanks);
    const finishedAt = match.finishedAt ?? (matchEnd.finished
      ? tanks
        .filter((tank) => tank.health <= 0)
        .map((tank) => tank.updatedAt)
        .sort((a, b) => a - b)[0]
      : undefined);
    const viewMatch = {
      ...match,
      status: match.status === "finished" || matchEnd.finished ? "finished" : players.length >= 2 ? "active" : match.status,
      ...(match.winnerPlayerId ?? matchEnd.winnerPlayerId ? { winnerPlayerId: match.winnerPlayerId ?? matchEnd.winnerPlayerId } : {}),
      ...(finishedAt ? { finishedAt } : {}),
    };

    return { match: viewMatch, board, players, tanks, orders: [], projectiles: [], events: visibleEvents, commandBatches, commandTimelines, ownPendingWork: false };
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

export const getLeaderboard = query({
  args: {},
  returns: v.array(
    v.object({
      commanderId: v.id("commanderProfiles"),
      displayName: v.string(),
      tankSpec: v.optional(tankSpecValidator),
      wins: v.number(),
      losses: v.number(),
      draws: v.number(),
      battles: v.number(),
    }),
  ),
  handler: async (ctx) => {
    const stats = await ctx.db
      .query("commanderStats")
      .withIndex("by_wins")
      .order("desc")
      .take(10);

    const rows = [];
    for (const entry of stats) {
      const commander = await ctx.db.get(entry.commanderId);
      if (!commander) {
        continue;
      }

      rows.push({
        commanderId: commander._id,
        displayName: commander.displayName,
        ...(commander.tankSpec ? { tankSpec: commander.tankSpec } : {}),
        wins: entry.wins,
        losses: entry.losses,
        draws: entry.draws,
        battles: entry.wins + entry.losses + entry.draws,
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

export const sendCommands = mutation({
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

    if (!match || match.status === "finished") {
      throw new Error("Battle not found");
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

    const commands = [];
    for (const command of args.commands) {
      const normalizedCommands = normalizeOrderCommand(command);
      if (normalizedCommands.length === 0) {
        throw new Error("Incorrect command");
      }
      commands.push(...normalizedCommands);
    }

    if (commands.length === 0) {
      return null;
    }

    const tanks = await ctx.db
      .query("tanks")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .take(2);

    await planCommandTimelines(ctx, match, player, tank, tanks, commands, now);

    return null;
  },
});

async function planCommandTimelines(ctx: any, match: any, player: any, tank: any, tanks: any[], commands: string[], now: number) {
  const byQueue = emptyCommandQueues();
  for (const command of commands) {
    const parsed = parseStoredCommand(command);
    if (!parsed) {
      throw new Error("Incorrect command");
    }
    byQueue[queueTypeForCommand(parsed)].push(command);
  }

  const recentBearingTimelines = await ctx.db
    .query("commandTimelines")
    .withIndex("by_player_queue_and_ended_at", (q: any) => q.eq("playerId", player._id).eq("queueType", "bearing"))
    .order("desc")
    .take(24);
  const plannedTimelines: any[] = [];
  const state: any = {
    position: cleanPosition(tank.position),
    baseHullDirection: angleFromDirection(tank.hullDirection),
    hullDirection: angleFromDirection(tank.hullDirection),
    turretDirection: angleFromDirection(tank.turretDirection),
    turretLocked: tank.turretLocked ?? true,
    launchAngle: clampFinite(tank.launchAngle, MIN_AIM_ELEVATION_DEGREES, MAX_AIM_ELEVATION_DEGREES, DEFAULT_FIRE_ANGLE_DEGREES),
    cannonPower: clampFinite(tank.cannonPower ?? tank.lastFirePower, MIN_FIRE_POWER, MAX_FIRE_POWER, DEFAULT_FIRE_POWER),
    tankSpec: normalizeTankSpec(tank.tankSpec),
    targets: tanks.filter((candidate) => candidate._id !== tank._id && candidate.health > 0),
  };

  for (const queueType of ["bearing", "move", "cannon"] as OrderQueueType[]) {
    let cursorAt = await nextTimelineStart(ctx, player._id, queueType, now + TIMELINE_PLAYBACK_DELAY_MS);
    for (const command of byQueue[queueType]) {
      const parsed = parseStoredCommand(command);
      if (!parsed) {
        continue;
      }

      const timeline = planTimeline(queueType, command, parsed, state, cursorAt, [
        ...recentBearingTimelines,
        ...plannedTimelines.filter((planned) => planned.queueType === "bearing"),
      ]);
      await ctx.db.insert("commandTimelines", {
        matchId: match._id,
        playerId: player._id,
        tankId: tank._id,
        queueType,
        command,
        startedAt: timeline.startedAt,
        endedAt: timeline.endedAt,
        points: timeline.points,
        createdAt: now,
      });
      plannedTimelines.push({ ...timeline, queueType, command, createdAt: now });
      cursorAt = timeline.endedAt;
    }
  }

  for (const hit of state.hits ?? []) {
    await ctx.db.patch(hit.targetTankId, {
      health: hit.targetHealthAfter,
      updatedAt: now,
    });
    if (hit.targetHealthAfter <= 0) {
      const targetTank = await ctx.db.get(hit.targetTankId);
      if (targetTank) {
        const targetPlayer = await ctx.db.get(targetTank.playerId);
        if (targetPlayer && !targetPlayer.finishedAt) {
          await ctx.db.patch(targetPlayer._id, { finishedAt: now });
        }
      }
    }
  }

  await ctx.db.patch(tank._id, {
    position: state.position,
    velocity: { x: 0, y: 0 },
    speed: 0,
    moveRemaining: 0,
    activeMoveCommand: "",
    hullDirection: normalizeDegrees(state.hullDirection),
    turretDirection: normalizeDegrees(state.turretDirection),
    turretLocked: state.turretLocked,
    launchAngle: state.launchAngle,
    cannonPower: state.cannonPower,
    lastFirePower: state.cannonPower,
    updatedAt: now,
  });
  await ctx.db.patch(match._id, { updatedAt: now });
  await finalizeMatchIfNeeded(ctx, match, now);
}

async function nextTimelineStart(ctx: any, playerId: any, queueType: OrderQueueType, now: number) {
  const previous = await ctx.db
    .query("commandTimelines")
    .withIndex("by_player_queue_and_ended_at", (q: any) => q.eq("playerId", playerId).eq("queueType", queueType))
    .order("desc")
    .first();
  return Math.max(now, previous?.endedAt ?? now);
}

function planTimeline(
  queueType: OrderQueueType,
  command: string,
  parsed: ReturnType<typeof parseStoredCommand> & {},
  state: any,
  startedAt: number,
  bearingTimelines: any[] = [],
) {
  if (queueType === "move" && parsed.action === "move") {
    const distance = moveCommandUnitsToDistance(parsed.units);
    const durationMs = Math.max(160, Math.round((Math.abs(distance) / (2 * UNITS_PER_SQUARE)) * 1000));
    const directionFallback = state.baseHullDirection ?? state.hullDirection;
    const points = movementTimelinePoints(startedAt, durationMs, distance, state.position, bearingTimelines, directionFallback);
    const to = points[points.length - 1]?.position ?? state.position;
    state.position = to;
    return { startedAt, endedAt: startedAt + durationMs, points };
  }

  if (queueType === "bearing" && parsed.action === "bear") {
    const fromHull = state.hullDirection;
    const delta = shortestAngleDelta(fromHull, parsed.bearing);
    const durationMs = Math.max(120, Math.round((Math.abs(delta) / 120) * 1000));
    const fromTurret = state.turretDirection;
    const points = linearTimelinePoints(startedAt, durationMs, (progress) => {
      const hullDirection = normalizeDegrees(fromHull + delta * progress);
      return {
        hullDirection,
        ...(state.turretLocked ? { turretDirection: normalizeDegrees(fromTurret + delta * progress) } : {}),
      };
    });
    state.hullDirection = normalizeDegrees(fromHull + delta);
    if (state.turretLocked) {
      state.turretDirection = normalizeDegrees(fromTurret + delta);
    }
    return { startedAt, endedAt: startedAt + durationMs, points };
  }

  if (queueType === "cannon" && parsed.action === "fire") {
    const points = projectileTimelinePoints(state, startedAt);
    const lastPoint: any = points[points.length - 1];
    const hit = lastPoint?.projectilePosition ? projectileHit(state, lastPoint.projectilePosition) : null;
    if (hit && lastPoint) {
      lastPoint.targetTankId = hit.targetTankId;
      lastPoint.damage = hit.damage;
      lastPoint.targetHealthBefore = hit.targetHealthBefore;
      lastPoint.targetHealthAfter = hit.targetHealthAfter;
      state.hits = [...(state.hits ?? []), hit];
      state.targets = state.targets.map((target: any) =>
        target._id === hit.targetTankId ? { ...target, health: hit.targetHealthAfter } : target,
      );
    }
    return { startedAt, endedAt: points[points.length - 1]?.at ?? startedAt + 40, points };
  }

  const durationMs = parsed.action === "aim" || parsed.action === "ret"
    ? Math.max(120, Math.round((Math.abs(shortestAngleDelta(state.turretDirection, parsed.action === "aim" ? parsed.bearing : state.hullDirection)) / 120) * 1000))
    : 120;
  const fromTurret = state.turretDirection;
  const fromElevation = state.launchAngle;
  const fromPower = state.cannonPower;
  const targetTurret = parsed.action === "aim" ? parsed.bearing : parsed.action === "ret" ? state.hullDirection : fromTurret;
  const turretDelta = shortestAngleDelta(fromTurret, targetTurret);
  const points = linearTimelinePoints(startedAt, durationMs, (progress) => ({
    turretDirection: normalizeDegrees(fromTurret + turretDelta * progress),
    launchAngle: parsed.action === "elev" ? fromElevation + (parsed.elevation - fromElevation) * progress : state.launchAngle,
    cannonPower: parsed.action === "pow" ? fromPower + (parsed.power - fromPower) * progress : state.cannonPower,
  }));
  if (parsed.action === "aim") {
    state.turretDirection = normalizeDegrees(parsed.bearing);
    state.turretLocked = false;
  } else if (parsed.action === "ret") {
    state.turretDirection = normalizeDegrees(state.hullDirection);
    state.turretLocked = true;
  } else if (parsed.action === "elev") {
    state.launchAngle = parsed.elevation;
  } else if (parsed.action === "pow") {
    state.cannonPower = parsed.power;
  }
  return { startedAt, endedAt: startedAt + durationMs, points };
}

function linearTimelinePoints(startedAt: number, durationMs: number, pointAt: (progress: number) => Record<string, unknown>) {
  const points = [];
  const stepMs = 40;
  for (let elapsed = 0; elapsed < durationMs; elapsed += stepMs) {
    points.push({ at: startedAt + elapsed, ...pointAt(elapsed / durationMs) });
  }
  points.push({ at: startedAt + durationMs, ...pointAt(1) });
  return points;
}

function movementTimelinePoints(
  startedAt: number,
  durationMs: number,
  distance: number,
  from: { x: number; y: number },
  bearingTimelines: any[],
  fallbackBearing: number,
) {
  const points = [];
  const stepMs = 40;
  const signedUnitsPerMs = distance / Math.max(1, durationMs);
  let position = cleanPosition(from);

  for (let elapsed = 0; elapsed < durationMs; elapsed += stepMs) {
    const at = startedAt + elapsed;
    if (elapsed > 0) {
      const previousAt = Math.max(startedAt, at - stepMs);
      const bearing = sampleBearingAt(bearingTimelines, previousAt + (at - previousAt) / 2, fallbackBearing);
      const delta = vectorFromBearing(bearing, signedUnitsPerMs * (at - previousAt));
      position = clampTankPosition({
        x: position.x + delta.x,
        y: position.y + delta.y,
      });
    }

    points.push({
      at,
      position,
      velocity: vectorFromBearing(sampleBearingAt(bearingTimelines, at, fallbackBearing), signedUnitsPerMs * stepMs),
    });
  }

  const lastAt = points[points.length - 1]?.at ?? startedAt;
  if (lastAt < startedAt + durationMs) {
    const bearing = sampleBearingAt(bearingTimelines, lastAt + (startedAt + durationMs - lastAt) / 2, fallbackBearing);
    const delta = vectorFromBearing(bearing, signedUnitsPerMs * (startedAt + durationMs - lastAt));
    position = clampTankPosition({
      x: position.x + delta.x,
      y: position.y + delta.y,
    });
  }

  points.push({
    at: startedAt + durationMs,
    position,
    velocity: { x: 0, y: 0 },
  });
  return points;
}

function sampleBearingAt(timelines: any[], at: number, fallbackBearing: number) {
  let bearing = normalizeDegrees(fallbackBearing);
  let hasPastBearing = false;
  const ordered = [...timelines].sort((left, right) => left.startedAt - right.startedAt || left.createdAt - right.createdAt);

  for (const timeline of ordered) {
    const points = timeline.points ?? [];
    if (timeline.queueType !== "bearing" || points.length === 0) {
      continue;
    }

    const firstBearing = points[0].hullDirection;
    const lastBearing = points[points.length - 1].hullDirection;
    if (at < timeline.startedAt) {
      return hasPastBearing || firstBearing === undefined ? bearing : normalizeDegrees(firstBearing);
    }
    if (at >= timeline.endedAt) {
      if (lastBearing !== undefined) {
        bearing = normalizeDegrees(lastBearing);
        hasPastBearing = true;
      }
      continue;
    }
    if (firstBearing !== undefined && at <= points[0].at) {
      return normalizeDegrees(firstBearing);
    }

    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const next = points[index];
      if (at > next.at) {
        continue;
      }
      if (previous.hullDirection === undefined || next.hullDirection === undefined) {
        return bearing;
      }
      const progress = (at - previous.at) / Math.max(1, next.at - previous.at);
      return normalizeDegrees(previous.hullDirection + shortestAngleDelta(previous.hullDirection, next.hullDirection) * progress);
    }

    if (lastBearing !== undefined) {
      return normalizeDegrees(lastBearing);
    }
  }

  return bearing;
}

function clampTankPosition(position: { x: number; y: number }) {
  return {
    x: clamp(position.x, UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS, (BOARD_SIZE - 1) * UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS),
    y: clamp(position.y, UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS, (BOARD_SIZE - 1) * UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS),
  };
}

function projectileTimelinePoints(state: any, startedAt: number) {
  const power = clampFinite(state.cannonPower, MIN_FIRE_POWER, MAX_FIRE_POWER, DEFAULT_FIRE_POWER);
  const launch = launchVelocity(power, state.launchAngle);
  const horizontalVelocity = vectorFromBearing(state.turretDirection, launch.horizontal);
  const mountOffset = vectorFromBearing(
    state.hullDirection,
    (state.tankSpec.turretOffset - 0.5) * TANK_LENGTH_UNITS,
  );
  const barrelVector = vectorFromBearing(
    state.turretDirection,
    (state.tankSpec.turretSize * TANK_WIDTH_UNITS) / 2 + state.tankSpec.cannonLength * TANK_LENGTH_UNITS,
  );
  const muzzle = clampProjectilePosition({
    x: state.position.x + mountOffset.x + barrelVector.x,
    y: state.position.y + mountOffset.y + barrelVector.y,
  }, BOARD_SIZE);
  const points = [];

  for (let elapsed = 0; elapsed <= 4000; elapsed += 40) {
    const ticks = elapsed / 40;
    const nextPosition = {
      x: muzzle.x + horizontalVelocity.x * ticks,
      y: muzzle.y + horizontalVelocity.y * ticks,
    };
    const nextHeight = launch.vertical * ticks - 0.5 * PROJECTILE_GRAVITY_UNITS * ticks * ticks;
    const nextVerticalVelocity = launch.vertical - PROJECTILE_GRAVITY_UNITS * ticks;
    const hitsWall =
      nextPosition.x <= UNITS_PER_SQUARE ||
      nextPosition.y <= UNITS_PER_SQUARE ||
      nextPosition.x >= BOARD_SIZE * UNITS_PER_SQUARE - UNITS_PER_SQUARE ||
      nextPosition.y >= BOARD_SIZE * UNITS_PER_SQUARE - UNITS_PER_SQUARE;
    const hitsGround = elapsed > 0 && nextHeight <= 0 && nextVerticalVelocity < 0;
    const position = clampProjectilePosition(nextPosition, BOARD_SIZE);

    points.push({
      at: startedAt + elapsed,
      projectilePosition: position,
      projectileVelocity: horizontalVelocity,
      projectileHeight: Math.max(0, nextHeight),
      projectileVerticalVelocity: nextVerticalVelocity,
      projectileStatus: hitsWall || hitsGround ? "exploding" as const : "active" as const,
      fire: elapsed === 0,
    });

    if (hitsWall || hitsGround) {
      break;
    }
  }

  return points.length > 0 ? points : [{
    at: startedAt,
    projectilePosition: muzzle,
    projectileVelocity: horizontalVelocity,
    projectileHeight: 0,
    projectileVerticalVelocity: launch.vertical,
    projectileStatus: "active",
    fire: true,
  }];
}

function projectileHit(state: any, position: { x: number; y: number }) {
  let bestHit = null;
  for (const target of state.targets ?? []) {
    const distance = distanceBetween(position, target.position);
    if (distance > PROJECTILE_HIT_RADIUS_UNITS) {
      continue;
    }

    if (bestHit && distance >= bestHit.distance) {
      continue;
    }

    const damage = damageForImpact(distance, MAX_PROJECTILE_DAMAGE);
    bestHit = {
      distance,
      targetTankId: target._id,
      damage,
      targetHealthBefore: target.health,
      targetHealthAfter: Math.max(0, target.health - damage),
    };
  }
  return bestHit;
}

function cleanPosition(position: { x: number; y: number }) {
  return {
    x: clampFinite(position.x, UNITS_PER_SQUARE, (BOARD_SIZE - 1) * UNITS_PER_SQUARE, spawnPoint(0).x),
    y: clampFinite(position.y, UNITS_PER_SQUARE, (BOARD_SIZE - 1) * UNITS_PER_SQUARE, spawnPoint(0).y),
  };
}

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
  await finalizeMatchIfNeeded(ctx, match, now);
}

async function finalizeMatchIfNeeded(ctx: any, match: any, now: number) {
  const currentMatch = await ctx.db.get(match._id);
  if (!currentMatch || currentMatch.status === "finished") {
    return;
  }

  const players = await ctx.db
    .query("players")
    .withIndex("by_match", (q: any) => q.eq("matchId", currentMatch._id))
    .take(2);
  const tanks = await ctx.db
    .query("tanks")
    .withIndex("by_match", (q: any) => q.eq("matchId", currentMatch._id))
    .take(2);
  const result = resolveMatchEnd(players, tanks);

  if (!result.finished) {
    return;
  }

  await ctx.db.patch(currentMatch._id, {
    status: "finished",
    finishedAt: now,
    updatedAt: now,
    ...(result.winnerPlayerId ? { winnerPlayerId: result.winnerPlayerId } : {}),
  });

  for (const participant of players) {
    if (!participant.commanderId) {
      continue;
    }

    await recordCommanderResult(
      ctx,
      participant.commanderId,
      result.winnerPlayerId
        ? participant._id === result.winnerPlayerId ? "win" : "loss"
        : "draw",
      now,
    );
  }
}

async function recordCommanderResult(ctx: any, commanderId: any, result: "win" | "loss" | "draw", now: number) {
  const existing = await ctx.db
    .query("commanderStats")
    .withIndex("by_commander", (q: any) => q.eq("commanderId", commanderId))
    .unique();
  const increment = {
    wins: result === "win" ? 1 : 0,
    losses: result === "loss" ? 1 : 0,
    draws: result === "draw" ? 1 : 0,
  };

  if (existing) {
    await ctx.db.patch(existing._id, {
      wins: existing.wins + increment.wins,
      losses: existing.losses + increment.losses,
      draws: existing.draws + increment.draws,
      updatedAt: now,
    });
    return;
  }

  await ctx.db.insert("commanderStats", {
    commanderId,
    ...increment,
    updatedAt: now,
  });
}

async function findCommanderPlayer(ctx: any, matchId: any, commanderId: any) {
  return await ctx.db
    .query("players")
    .withIndex("by_match_and_commander", (q: any) => q.eq("matchId", matchId).eq("commanderId", commanderId))
    .unique();
}

async function playersForMatch(ctx: any, matchId: any) {
  return await ctx.db
    .query("players")
    .withIndex("by_match", (q: any) => q.eq("matchId", matchId))
    .take(2);
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

function activeOrderForQueue(orders: any[], tankId: any, queueType: OrderQueueType) {
  return orders
    .filter((order) => order.tankId === tankId && order.status !== "complete" && orderQueueType(order) === queueType)
    .sort((left, right) => (left.createdAt ?? left._creationTime ?? 0) - (right.createdAt ?? right._creationTime ?? 0))[0];
}

function appendWall(walls: { x: number; y: number }[], wall: { x: number; y: number }) {
  if (!walls.some((candidate) => candidate.x === wall.x && candidate.y === wall.y)) {
    walls.push(wall);
  }
}

function cleanSingleCommand(command: string) {
  const commands = normalizeOrderCommand(command);
  return commands.length === 1 ? commands[0] : null;
}

function cleanClientCommandId(clientCommandId: string) {
  return clientCommandId.trim().slice(0, 80);
}

function cleanTankCheckpoint(tank: {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  speed?: number;
  moveRemaining?: number;
  activeMoveCommand?: string;
  hullDirection: number;
  turretDirection: number;
  turretLocked?: boolean;
  launchAngle?: number;
  cannonPower?: number;
  lastFirePower?: number;
  health: number;
  updatedAt: number;
}, now: number) {
  return {
    position: cleanVector(tank.position),
    velocity: cleanVector(tank.velocity),
    speed: cleanOptionalNumber(tank.speed, 0),
    moveRemaining: cleanOptionalNumber(tank.moveRemaining, 0),
    activeMoveCommand: tank.activeMoveCommand?.slice(0, 64) ?? "",
    hullDirection: normalizeDegrees(cleanNumber(tank.hullDirection, 0)),
    turretDirection: normalizeDegrees(cleanNumber(tank.turretDirection, 0)),
    turretLocked: Boolean(tank.turretLocked),
    launchAngle: clampFinite(tank.launchAngle, MIN_AIM_ELEVATION_DEGREES, MAX_AIM_ELEVATION_DEGREES, DEFAULT_FIRE_ANGLE_DEGREES),
    cannonPower: clampFinite(tank.cannonPower, MIN_FIRE_POWER, MAX_FIRE_POWER, DEFAULT_FIRE_POWER),
    lastFirePower: clampFinite(tank.lastFirePower, MIN_FIRE_POWER, MAX_FIRE_POWER, DEFAULT_FIRE_POWER),
    health: clampFinite(tank.health, 0, MAX_HEALTH, MAX_HEALTH),
    updatedAt: Math.max(cleanNumber(tank.updatedAt, now), now),
  };
}

function cleanVector(vector: { x: number; y: number }) {
  return {
    x: cleanNumber(vector.x, 0),
    y: cleanNumber(vector.y, 0),
  };
}

function cleanOptionalNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cleanNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
