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
    createdAt: v.number(),
  }).index("by_match", ["matchId"]),

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
  }).index("by_match", ["matchId"]),

  orders: defineTable({
    matchId: v.id("matches"),
    playerId: v.id("players"),
    tankId: v.id("tanks"),
    commands: v.array(v.string()),
    cursor: v.number(),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("complete"),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_match", ["matchId"]),

  projectiles: defineTable({
    matchId: v.id("matches"),
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
  }).index("by_match", ["matchId"]),

  collisionEvents: defineTable({
    matchId: v.id("matches"),
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
  }).index("by_match_and_created_at", ["matchId", "createdAt"]),
});
