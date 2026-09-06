import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const vector = v.object({
  x: v.number(),
  y: v.number(),
});

const legacyDirection = v.union(
  v.literal("north"),
  v.literal("east"),
  v.literal("south"),
  v.literal("west"),
);

export default defineSchema({
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
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_room_code", ["roomCode"])
    .index("by_lobby_and_created_at", ["lobbyId", "createdAt"]),

  players: defineTable({
    matchId: v.id("matches"),
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
    hullDirection: v.union(v.number(), legacyDirection),
    turretDirection: v.union(v.number(), legacyDirection),
    turretLocked: v.optional(v.boolean()),
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
});
