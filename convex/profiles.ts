import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";

const MAX_DISPLAY_NAME_LENGTH = 32;

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
