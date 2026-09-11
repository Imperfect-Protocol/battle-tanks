import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  BOARD_SIZE,
  DEFAULT_FIRE_ANGLE_DEGREES,
  DEFAULT_FIRE_POWER,
  DEFAULT_LOBBY_ID,
  MAX_HEALTH,
  MAX_MOVE_DISTANCE_UNITS,
  ORDER_QUEUE_TYPES,
  UNITS_PER_SQUARE,
  angleFromDirection,
  cleanBattleName,
  clampFinite,
  clampInteger,
  commandHelp,
  compressCommandQueues,
  completeActiveOrdersForQueue,
  distanceToMoveCommandUnits,
  emptyCommandQueues,
  moveCommandUnitsToDistance,
  normalizeLobbyId,
  normalizeOrderCommand,
  normalizeRoom,
  normalizeTankSpec,
  parseStoredCommand,
  queueTypeForCommand,
  sha256,
  spawnPoint,
  tankSpecFromSeed,
  unitsPerTickToSquaresPerSecond,
  vectorLength,
} from "./gameCore";

const vectorValidator = v.object({
  x: v.number(),
  y: v.number(),
});

const tankSpecValidator = v.object({
  hullColor: v.string(),
  turretOffset: v.number(),
  cannonLength: v.number(),
  turretSize: v.number(),
});

const lobbyValidator = v.object({
  id: v.string(),
  name: v.string(),
  description: v.string(),
});

const gameSummaryValidator = v.object({
  roomCode: v.string(),
  battleName: v.optional(v.string()),
  lobbyId: v.string(),
  status: v.union(v.literal("lobby"), v.literal("active")),
  currentTick: v.number(),
  playerCount: v.number(),
  maxPlayers: v.number(),
  canJoin: v.boolean(),
  players: v.array(v.string()),
  updatedAt: v.number(),
});

export const listLobbies = query({
  args: {},
  returns: v.object({
    lobbies: v.array(lobbyValidator),
  }),
  handler: async () => ({
    lobbies: [
      {
        id: DEFAULT_LOBBY_ID,
        name: "PvP",
        description: "Two-player realtime tank battles.",
      },
    ],
  }),
});

export const listGames = query({
  args: { lobbyId: v.optional(v.string()) },
  returns: v.object({
    lobbyId: v.string(),
    games: v.array(gameSummaryValidator),
  }),
  handler: async (ctx, args) => {
    const lobbyId = normalizeLobbyId(args.lobbyId);
    const matches = await ctx.db
      .query("matches")
      .withIndex("by_lobby_and_created_at", (q) => q.eq("lobbyId", lobbyId))
      .order("desc")
      .take(50);

    const games = [];
    for (const match of matches) {
      if (match.status === "finished") {
        continue;
      }

      const players = await ctx.db
        .query("players")
        .withIndex("by_match", (q) => q.eq("matchId", match._id))
        .take(2);

      const status = players.length >= 2 ? "active" as const : "lobby" as const;
      games.push({
        roomCode: match.roomCode,
        ...(match.battleName ? { battleName: match.battleName } : {}),
        lobbyId,
        status,
        currentTick: match.currentTick,
        playerCount: players.length,
        maxPlayers: 2,
        canJoin: players.length < 2,
        players: players.map((player) => player.name),
        updatedAt: match.updatedAt,
      });
    }

    return { lobbyId, games };
  },
});

export const createGame = mutation({
  args: {
    agentName: v.string(),
    battleName: v.optional(v.string()),
    roomCode: v.optional(v.string()),
  },
  returns: v.object({
    roomCode: v.string(),
    battleName: v.string(),
    agentKey: v.string(),
    playerName: v.string(),
    slot: v.literal("alpha"),
    commandHelp: v.string(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const playerName = cleanName(args.agentName);
    if (!playerName) {
      throw new Error("Agent name required");
    }

    const roomCode = await reserveRoomCode(ctx, args.roomCode);
    const battleName = cleanBattleName(args.battleName);
    const existingName = await ctx.db
      .query("matches")
      .withIndex("by_lobby_and_battle_name", (q) => q.eq("lobbyId", DEFAULT_LOBBY_ID).eq("battleName", battleName))
      .first();
    if (existingName) {
      throw new Error("Battle name already used");
    }

    const agentKey = `bt_${crypto.randomUUID()}`;
    const agentKeyHash = await sha256(agentKey);
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
      agentKeyHash,
      name: playerName,
      slot: "alpha",
      score: 0,
      createdAt: now,
    });
    await insertTank(ctx, matchId, playerId, "alpha", playerName, now);

    return { roomCode, battleName, agentKey, playerName, slot: "alpha" as const, commandHelp };
  },
});

export const joinGame = mutation({
  args: {
    roomCode: v.string(),
    agentName: v.string(),
  },
  returns: v.object({
    roomCode: v.string(),
    battleName: v.string(),
    agentKey: v.string(),
    playerName: v.string(),
    slot: v.union(v.literal("alpha"), v.literal("bravo")),
    commandHelp: v.string(),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const roomCode = normalizeRoom(args.roomCode);
    const playerName = cleanName(args.agentName);
    if (!playerName) {
      throw new Error("Agent name required");
    }

    const match = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q) => q.eq("roomCode", roomCode))
      .unique();
    if (!match) {
      throw new Error("Battle not found");
    }
    if (match.status === "finished") {
      throw new Error("Battle already finished");
    }

    const players = await ctx.db
      .query("players")
      .withIndex("by_match", (q) => q.eq("matchId", match._id))
      .take(2);
    if (players.some((player) => player.name.toLowerCase() === playerName.toLowerCase())) {
      throw new Error("Player name already used in this battle");
    }
    if (players.length >= 2) {
      throw new Error("Battle is full");
    }

    const slot = players.some((player) => player.slot === "alpha") ? "bravo" as const : "alpha" as const;
    const agentKey = `bt_${crypto.randomUUID()}`;
    const agentKeyHash = await sha256(agentKey);
    const playerId = await ctx.db.insert("players", {
      matchId: match._id,
      agentKeyHash,
      name: playerName,
      slot,
      score: 0,
      createdAt: now,
    });
    await insertTank(ctx, match._id, playerId, slot, playerName, now);
    return { roomCode, battleName: match.battleName ?? "Battle", agentKey, playerName, slot, commandHelp };
  },
});

export const issueCommands = mutation({
  args: {
    roomCode: v.string(),
    agentKey: v.string(),
    commands: v.array(v.string()),
  },
  returns: v.object({
    accepted: v.array(v.string()),
  }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const { match, player, tank } = await requireAgentTank(ctx, args.roomCode, args.agentKey);
    if (match.status === "finished") {
      throw new Error("Battle already finished");
    }

    const commandsByQueue = emptyCommandQueues();
    for (const command of args.commands) {
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
    const acceptedCommands = ORDER_QUEUE_TYPES.flatMap((queueType) => queuedCommands[queueType]);
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
        .withIndex("by_player", (q) => q.eq("playerId", player._id))
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

    return { accepted: acceptedCommands };
  },
});

export const observeBattle = query({
  args: {
    roomCode: v.string(),
    agentKey: v.optional(v.string()),
  },
  returns: v.object({
    battle: v.union(v.null(), v.object({
      roomCode: v.string(),
      battleName: v.string(),
      status: v.union(v.literal("lobby"), v.literal("active"), v.literal("finished")),
      currentTick: v.number(),
      board: v.object({
        sizeSquares: v.number(),
        unitsPerSquare: v.number(),
      }),
      ownPlayerName: v.optional(v.string()),
      tanks: v.array(v.object({
        playerName: v.string(),
        slot: v.union(v.literal("alpha"), v.literal("bravo")),
        isOwnTank: v.boolean(),
        position: vectorValidator,
        velocity: vectorValidator,
        speedSquaresPerSecond: v.number(),
        hullBearing: v.number(),
        aimBearing: v.number(),
        remainingHp: v.number(),
        elevation: v.optional(v.number()),
        cannonPower: v.optional(v.number()),
        moveRemainingCommandUnits: v.optional(v.number()),
        tankSpec: tankSpecValidator,
      })),
      projectiles: v.array(v.object({
        position: vectorValidator,
        velocity: vectorValidator,
        height: v.number(),
        ownerPlayerName: v.string(),
        status: v.union(v.literal("active"), v.literal("exploding")),
      })),
      recentCollisions: v.array(v.object({
        type: v.union(v.literal("wall"), v.literal("tank")),
        tick: v.number(),
        tankName: v.string(),
        otherTankName: v.optional(v.string()),
        position: vectorValidator,
        normal: vectorValidator,
        impactSpeedSquaresPerSecond: v.number(),
        damageToTank: v.number(),
        damageToOther: v.optional(v.number()),
      })),
    })),
  }),
  handler: async (ctx, args) => {
    const match = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q) => q.eq("roomCode", normalizeRoom(args.roomCode)))
      .unique();
    if (!match) {
      return { battle: null };
    }

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
      .take(20);
    const recentCollisionRows = await ctx.db
      .query("collisionEvents")
      .withIndex("by_match_and_created_at", (q) => q.eq("matchId", match._id))
      .order("desc")
      .take(10);
    const agentPlayer = args.agentKey ? await findAgentPlayer(ctx, match._id, args.agentKey) : null;
    if (args.agentKey && !agentPlayer) {
      throw new Error("Invalid agent key");
    }
    const playerById = new Map(players.map((player) => [player._id, player]));
    const tankById = new Map(tanks.map((tank) => [tank._id, tank]));

    return {
      battle: {
        roomCode: match.roomCode,
        battleName: match.battleName ?? "Battle",
        status: match.status,
        currentTick: match.currentTick,
        board: {
          sizeSquares: BOARD_SIZE,
          unitsPerSquare: UNITS_PER_SQUARE,
        },
        ...(agentPlayer ? { ownPlayerName: agentPlayer.name } : {}),
        tanks: tanks.map((tank) => {
          const player = playerById.get(tank.playerId);
          const isOwnTank = tank.playerId === agentPlayer?._id;
          return {
            playerName: player?.name ?? "Unknown",
            slot: player?.slot ?? "alpha",
            isOwnTank,
            position: tank.position,
            velocity: tank.velocity,
            speedSquaresPerSecond: unitsPerTickToSquaresPerSecond(vectorLength(tank.velocity)),
            hullBearing: angleFromDirection(tank.hullDirection),
            aimBearing: angleFromDirection(tank.turretDirection),
            remainingHp: tank.health,
            ...(isOwnTank ? {
              elevation: tank.launchAngle ?? DEFAULT_FIRE_ANGLE_DEGREES,
              cannonPower: tank.cannonPower ?? tank.lastFirePower ?? DEFAULT_FIRE_POWER,
              moveRemainingCommandUnits: distanceToMoveCommandUnits(tank.moveRemaining ?? 0),
            } : {}),
            tankSpec: normalizeTankSpec(tank.tankSpec),
          };
        }),
        projectiles: projectiles
          .filter((projectile) => projectile.status === "active" || projectile.status === "exploding")
          .map((projectile) => {
            const ownerTank = tankById.get(projectile.ownerTankId);
            const ownerPlayer = ownerTank ? playerById.get(ownerTank.playerId) : null;
            return {
              position: projectile.position,
              velocity: projectile.velocity,
              height: projectile.height ?? 0,
              ownerPlayerName: ownerPlayer?.name ?? "Unknown",
              status: projectile.status === "exploding" ? "exploding" as const : "active" as const,
            };
          }),
        recentCollisions: recentCollisionRows.map((event) => {
          const tank = tankById.get(event.tankId);
          const tankPlayer = tank ? playerById.get(tank.playerId) : null;
          const otherTank = event.otherTankId ? tankById.get(event.otherTankId) : null;
          const otherPlayer = otherTank ? playerById.get(otherTank.playerId) : null;
          return {
            type: event.type,
            tick: event.tick,
            tankName: tankPlayer?.name ?? "Unknown",
            ...(otherPlayer ? { otherTankName: otherPlayer.name } : {}),
            position: event.position,
            normal: event.normal,
            impactSpeedSquaresPerSecond: unitsPerTickToSquaresPerSecond(event.impactSpeed),
            damageToTank: event.damageToTank,
            ...(event.damageToOther !== undefined ? { damageToOther: event.damageToOther } : {}),
          };
        }),
      },
    };
  },
});

export const recentCollisions = query({
  args: {
    roomCode: v.string(),
    limit: v.optional(v.number()),
  },
  returns: v.object({
    collisions: v.array(v.object({
      type: v.union(v.literal("wall"), v.literal("tank")),
      tick: v.number(),
      position: vectorValidator,
      normal: vectorValidator,
      impactSpeedSquaresPerSecond: v.number(),
      damageToTank: v.number(),
      damageToOther: v.optional(v.number()),
    })),
  }),
  handler: async (ctx, args) => {
    const match = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q) => q.eq("roomCode", normalizeRoom(args.roomCode)))
      .unique();
    if (!match) {
      return { collisions: [] };
    }

    const limit = clampInteger(args.limit ?? 10, 1, 20);
    const collisions = await ctx.db
      .query("collisionEvents")
      .withIndex("by_match_and_created_at", (q) => q.eq("matchId", match._id))
      .order("desc")
      .take(limit);

    return {
      collisions: collisions.map((event) => ({
        type: event.type,
        tick: event.tick,
        position: event.position,
        normal: event.normal,
        impactSpeedSquaresPerSecond: unitsPerTickToSquaresPerSecond(event.impactSpeed),
        damageToTank: event.damageToTank,
        ...(event.damageToOther !== undefined ? { damageToOther: event.damageToOther } : {}),
      })),
    };
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

async function reserveRoomCode(ctx: any, requestedRoomCode: string | undefined) {
  if (requestedRoomCode) {
    const roomCode = normalizeRoom(requestedRoomCode);
    const existing = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q: any) => q.eq("roomCode", roomCode))
      .unique();
    if (existing) {
      throw new Error("Battle code already used");
    }
    return roomCode;
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const roomCode = normalizeRoom(crypto.randomUUID());
    const existing = await ctx.db
      .query("matches")
      .withIndex("by_room_code", (q: any) => q.eq("roomCode", roomCode))
      .unique();
    if (!existing) {
      return roomCode;
    }
  }

  throw new Error("Could not allocate battle code");
}

async function insertTank(ctx: any, matchId: any, playerId: any, slot: "alpha" | "bravo", playerName: string, now: number) {
  await ctx.db.insert("tanks", {
    matchId,
    playerId,
    position: slot === "alpha" ? spawnPoint(0) : spawnPoint(1),
    velocity: { x: 0, y: 0 },
    speed: 0,
    moveRemaining: 0,
    hullDirection: slot === "alpha" ? 90 : 270,
    turretDirection: slot === "alpha" ? 90 : 270,
    turretLocked: true,
    tankSpec: tankSpecFromSeed(`${matchId}:${playerId}:${playerName}`),
    ammoType: "missile",
    launchAngle: DEFAULT_FIRE_ANGLE_DEGREES,
    cannonPower: DEFAULT_FIRE_POWER,
    lastFirePower: DEFAULT_FIRE_POWER,
    health: MAX_HEALTH,
    updatedAt: now,
  });
}

async function requireAgentTank(ctx: any, roomCode: string, agentKey: string) {
  const match = await ctx.db
    .query("matches")
    .withIndex("by_room_code", (q: any) => q.eq("roomCode", normalizeRoom(roomCode)))
    .unique();
  if (!match) {
    throw new Error("Battle not found");
  }

  const player = await findAgentPlayer(ctx, match._id, agentKey);
  if (!player) {
    throw new Error("Invalid agent key");
  }

  const tank = await ctx.db
    .query("tanks")
    .withIndex("by_player", (q: any) => q.eq("playerId", player._id))
    .unique();
  if (!tank || tank.matchId !== match._id) {
    throw new Error("Tank not found");
  }

  return { match, player, tank };
}

async function findAgentPlayer(ctx: any, matchId: any, agentKey: string) {
  const agentKeyHash = await sha256(agentKey);
  return await ctx.db
    .query("players")
    .withIndex("by_match_and_agent_key", (q: any) => q.eq("matchId", matchId).eq("agentKeyHash", agentKeyHash))
    .unique();
}

function cleanName(name: string) {
  return name.trim().replace(/\s+/g, " ").slice(0, 32);
}
