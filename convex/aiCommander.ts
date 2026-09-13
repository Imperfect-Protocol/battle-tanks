import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { mutation, query } from "./_generated/server";
import {
  AI_COMMANDER_LIMITS,
  IntentFilePolicy,
} from "./aiCommanderLogic";

const intentFileSummary = v.object({
  id: v.id("intentFiles"),
  filename: v.string(),
  size: v.number(),
  createdAt: v.number(),
  updatedAt: v.number(),
});

export const listIntentFiles = query({
  args: {
    commanderId: v.id("commanderProfiles"),
  },
  returns: v.array(intentFileSummary),
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const commander = await ctx.db.get(args.commanderId);
    if (!commander || commander.userId !== userId) {
      return [];
    }

    const files = await ctx.db
      .query("intentFiles")
      .withIndex("by_user_and_updated_at", (q) => q.eq("userId", userId))
      .order("desc")
      .take(AI_COMMANDER_LIMITS.recentIntentFileLimit);
    const policy = new IntentFilePolicy();

    return files.map((file) => policy.toSummary(file));
  },
});

export const saveIntentFile = mutation({
  args: {
    commanderId: v.id("commanderProfiles"),
    filename: v.string(),
    content: v.string(),
  },
  returns: intentFileSummary,
  handler: async (ctx, args) => {
    const userId = await requireUserId(ctx);
    const commander = await ctx.db.get(args.commanderId);
    if (!commander || commander.userId !== userId) {
      throw new Error("Commander not found");
    }

    const policy = new IntentFilePolicy();
    const prepared = policy.prepare(args.filename, args.content);

    const now = Date.now();
    const id = await ctx.db.insert("intentFiles", {
      userId,
      commanderId: args.commanderId,
      filename: prepared.filename,
      content: prepared.content,
      size: prepared.size,
      createdAt: now,
      updatedAt: now,
    });

    return policy.toSummary({ _id: id, ...prepared, createdAt: now, updatedAt: now });
  },
});

async function requireUserId(ctx: any) {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new Error("Sign in before using AI commander files");
  }
  return userId;
}
