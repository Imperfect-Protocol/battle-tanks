import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { authTables } from "@convex-dev/auth/server";

const vector = v.object({
  x: v.number(),
  y: v.number(),
});

const tankSpec = v.object({
  hullColor: v.string(),
  turretOffset: v.number(),
  cannonLength: v.number(),
  turretSize: v.number(),
});

const legacyDirection = v.union(
  v.literal("north"),
  v.literal("east"),
  v.literal("south"),
  v.literal("west"),
);

export default defineSchema({
  ...authTables,

  commanderProfiles: defineTable({
    userId: v.id("users"),
    displayName: v.string(),
    tankSpec: v.optional(tankSpec),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_display_name", ["displayName"]),

  boards: defineTable({
    code: v.string(),
    name: v.string(),
    size: v.number(),
    walls: v.array(vector),
    spawnPoints: v.array(vector),
    createdAt: v.number(),
  }).index("by_code", ["code"]),

  matches: defineTable({
    boardId: v.id("boards"),
    roomCode: v.string(),
    lobbyId: v.optional(v.string()),
    battleName: v.optional(v.string()),
    status: v.union(
      v.literal("lobby"),
      v.literal("active"),
      v.literal("finished"),
    ),
    currentTick: v.number(),
    winnerPlayerId: v.optional(v.id("players")),
    lastTickAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_room_code", ["roomCode"])
    .index("by_lobby_and_created_at", ["lobbyId", "createdAt"])
    .index("by_lobby_and_battle_name", ["lobbyId", "battleName"])
    .index("by_lobby_status_and_created_at", ["lobbyId", "status", "createdAt"]),

  players: defineTable({
    matchId: v.id("matches"),
    userId: v.optional(v.id("users")),
    commanderId: v.optional(v.id("commanderProfiles")),
    agentKeyHash: v.optional(v.string()),
    name: v.string(),
    slot: v.union(v.literal("alpha"), v.literal("bravo")),
    score: v.number(),
    lastTickAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_match", ["matchId"])
    .index("by_match_and_user", ["matchId", "userId"])
    .index("by_match_and_commander", ["matchId", "commanderId"])
    .index("by_match_and_agent_key", ["matchId", "agentKeyHash"]),

  tanks: defineTable({
    matchId: v.id("matches"),
    playerId: v.id("players"),
    position: vector,
    velocity: vector,
    speed: v.optional(v.number()),
    moveRemaining: v.optional(v.number()),
    activeMoveCommand: v.optional(v.string()),
    hullDirection: v.union(v.number(), legacyDirection),
    turretDirection: v.union(v.number(), legacyDirection),
    turretLocked: v.optional(v.boolean()),
    launchAngle: v.optional(v.number()),
    cannonPower: v.optional(v.number()),
    lastFirePower: v.optional(v.number()),
    tankSpec: v.optional(tankSpec),
    ammoType: v.union(v.literal("missile")),
    health: v.number(),
    updatedAt: v.number(),
  })
    .index("by_match", ["matchId"])
    .index("by_player", ["playerId"]),

  orders: defineTable({
    matchId: v.id("matches"),
    playerId: v.id("players"),
    tankId: v.id("tanks"),
    queueType: v.optional(v.union(v.literal("move"), v.literal("bearing"), v.literal("cannon"))),
    commands: v.array(v.string()),
    cursor: v.number(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_match", ["matchId"])
    .index("by_player", ["playerId"]),

  projectiles: defineTable({
    matchId: v.id("matches"),
    ownerPlayerId: v.optional(v.id("players")),
    ownerTankId: v.id("tanks"),
    position: vector,
    velocity: vector,
    damage: v.number(),
    rangeRemaining: v.optional(v.number()),
    height: v.optional(v.number()),
    verticalVelocity: v.optional(v.number()),
    launchPower: v.optional(v.number()),
    launchAngle: v.optional(v.number()),
    explosionEndsAt: v.optional(v.number()),
    status: v.union(v.literal("active"), v.literal("exploding"), v.literal("spent")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_match", ["matchId"])
    .index("by_owner_tank", ["ownerTankId"])
    .index("by_owner_player", ["ownerPlayerId"]),

  collisionEvents: defineTable({
    matchId: v.id("matches"),
    ownerPlayerId: v.optional(v.id("players")),
    tankId: v.id("tanks"),
    otherTankId: v.optional(v.id("tanks")),
    type: v.union(v.literal("wall"), v.literal("tank")),
    position: vector,
    normal: vector,
    impactSpeed: v.number(),
    damageToTank: v.number(),
    damageToOther: v.optional(v.number()),
    tick: v.number(),
    createdAt: v.number(),
  })
    .index("by_match_and_created_at", ["matchId", "createdAt"])
    .index("by_owner_player_and_created_at", ["ownerPlayerId", "createdAt"]),

  worldEvents: defineTable({
    matchId: v.id("matches"),
    sourcePlayerId: v.id("players"),
    sourceTankId: v.id("tanks"),
    targetTankId: v.optional(v.id("tanks")),
    projectileId: v.optional(v.id("projectiles")),
    type: v.union(v.literal("explosion"), v.literal("tankCollision")),
    position: vector,
    normal: v.optional(vector),
    radius: v.optional(v.number()),
    damage: v.number(),
    impactSpeed: v.optional(v.number()),
    penetration: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_match_and_expires_at", ["matchId", "expiresAt"])
    .index("by_source_player_and_expires_at", ["sourcePlayerId", "expiresAt"])
    .index("by_projectile", ["projectileId"]),

  worldEventApplications: defineTable({
    matchId: v.id("matches"),
    playerId: v.optional(v.id("players")),
    eventId: v.id("worldEvents"),
    tankId: v.id("tanks"),
    createdAt: v.number(),
  })
    .index("by_event", ["eventId"])
    .index("by_event_and_tank", ["eventId", "tankId"])
    .index("by_player_and_event", ["playerId", "eventId"])
    .index("by_player_and_created_at", ["playerId", "createdAt"]),
});
