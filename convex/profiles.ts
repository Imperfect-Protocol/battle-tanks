import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";

const MAX_DISPLAY_NAME_LENGTH = 32;
const TANK_COLORS = ["#24f7a7", "#40d8ff", "#ffe45c", "#ff6b9d", "#b5ff5c", "#ff9c45"];
const TURRET_OFFSETS = [0.28, 0.333, 0.4, 0.48, 0.58];
const CANNON_LENGTHS = [0.32, 0.38, 0.44, 0.5, 0.56];
const TURRET_SIZES = [0.76, 0.84, 0.92, 1, 1.06];

const tankSpecValidator = v.object({
  hullColor: v.string(),
  turretOffset: v.number(),
  cannonLength: v.number(),
  turretSize: v.number(),
});

export const getViewer = query({
  args: {},
  returns: v.union(
    v.null(),
    v.object({
      userId: v.id("users"),
      commanders: v.array(
        v.object({
          id: v.id("commanderProfiles"),
          displayName: v.string(),
          tankSpec: tankSpecValidator,
        }),
      ),
      suggestedDisplayName: v.string(),
      email: v.optional(v.string()),
      name: v.optional(v.string()),
      image: v.optional(v.string()),
    }),
  ),
  handler: async (ctx) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      return null;
    }

    const user = await ctx.db.get(userId);
    const commanders = await ctx.db
      .query("commanderProfiles")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .take(25);

    return {
      userId,
      commanders: commanders.map((commander) => ({
        id: commander._id,
        displayName: commander.displayName,
        tankSpec: commander.tankSpec ?? tankSpecFromSeed(`${commander._id}:${commander.displayName}`),
      })),
      suggestedDisplayName: suggestDisplayName(user?.name, user?.email),
      email: user?.email,
      name: user?.name,
      image: user?.image,
    };
  },
});

export const isDisplayNameTaken = query({
  args: { displayName: v.string() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const displayName = cleanDisplayName(args.displayName);
    if (!displayName) {
      return false;
    }

    const userId = await getAuthUserId(ctx);
    const existingProfile = await ctx.db
      .query("commanderProfiles")
      .withIndex("by_display_name", (q) => q.eq("displayName", displayName))
      .unique();

    return Boolean(existingProfile && existingProfile.userId !== userId);
  },
});

export const claimDisplayName = mutation({
  args: { displayName: v.string(), commanderId: v.optional(v.id("commanderProfiles")) },
  returns: v.object({
    commanderId: v.id("commanderProfiles"),
    userId: v.id("users"),
    displayName: v.string(),
  }),
  handler: async (ctx, args) => {
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Sign in before choosing a commander name");
    }

    const displayName = cleanDisplayName(args.displayName);
    if (!displayName) {
      throw new Error("Commander name required");
    }

    const existingNameProfile = await ctx.db
      .query("commanderProfiles")
      .withIndex("by_display_name", (q) => q.eq("displayName", displayName))
      .unique();

    if (existingNameProfile && existingNameProfile.userId !== userId) {
      throw new Error("Name already taken");
    }

    const now = Date.now();
    if (args.commanderId) {
      const existingCommander = await ctx.db.get(args.commanderId);
      if (!existingCommander || existingCommander.userId !== userId) {
        throw new Error("Commander not found");
      }
      if (existingNameProfile && existingNameProfile._id !== args.commanderId) {
        throw new Error("Name already taken");
      }

      await ctx.db.patch(args.commanderId, {
        displayName,
        updatedAt: now,
      });
      return { commanderId: args.commanderId, userId, displayName };
    }

    if (existingNameProfile) {
      throw new Error("Name already taken");
    }

    const commanderId = await ctx.db.insert("commanderProfiles", {
      userId,
      displayName,
      tankSpec: tankSpecFromSeed(`${userId}:${displayName}:${now}`),
      createdAt: now,
      updatedAt: now,
    });

    return { commanderId, userId, displayName };
  },
});

function cleanDisplayName(displayName: string) {
  return displayName.trim().replace(/\s+/g, " ").slice(0, MAX_DISPLAY_NAME_LENGTH);
}

function suggestDisplayName(name: string | undefined, email: string | undefined) {
  const fromName = cleanDisplayName(name ?? "");
  if (fromName) {
    return fromName;
  }

  return cleanDisplayName(email?.split("@")[0] ?? "") || "Commander";
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
