import { v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { makeFunctionReference } from "convex/server";
import { action } from "./_generated/server";
import { NebiusCommanderClient } from "./aiCommanderLogic";

const buildAssistSnapshot = makeFunctionReference<"query">("aiCommanderSnapshots:buildAssistSnapshot");

const assistResult = v.object({
  commandLine: v.string(),
  commands: v.array(v.string()),
  tasks: v.optional(v.array(v.string())),
  achieved: v.optional(v.boolean()),
  stopReason: v.optional(v.string()),
  provider: v.string(),
  model: v.string(),
  configured: v.boolean(),
  latencyMs: v.number(),
  inputTokens: v.optional(v.number()),
  outputTokens: v.optional(v.number()),
  estimatedCostUsd: v.optional(v.number()),
  debugInput: v.optional(v.any()),
  debugPrompt: v.optional(v.any()),
  debugReply: v.optional(v.any()),
});

export const assist = action({
  args: {
    roomCode: v.string(),
    commanderId: v.id("commanderProfiles"),
    intentFileId: v.id("intentFiles"),
    intent: v.string(),
    model: v.optional(v.string()),
    mode: v.optional(v.union(v.literal("assist"), v.literal("plan"), v.literal("command"), v.literal("review"))),
    task: v.optional(v.string()),
    tasks: v.optional(v.array(v.string())),
    completedTask: v.optional(v.string()),
    completedCommands: v.optional(v.array(v.string())),
  },
  returns: assistResult,
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    const userId = await getAuthUserId(ctx);
    if (!userId) {
      throw new Error("Sign in before using AI commander files");
    }

    const { model, mode, task, tasks, completedTask, completedCommands, roomCode, commanderId, intentFileId, intent } = args;
    const snapshot = await ctx.runQuery(buildAssistSnapshot, { roomCode, commanderId, intentFileId, intent, userId });
    return await new NebiusCommanderClient(process.env).assist(
      {
        ...snapshot,
        aiRequest: {
          mode: mode ?? "assist",
          task: task ?? null,
          tasks: tasks ?? [],
          completedTask: completedTask ?? null,
          completedCommands: completedCommands ?? [],
        },
      },
      startedAt,
      model,
    );
  },
});
