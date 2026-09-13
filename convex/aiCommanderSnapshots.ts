import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { BattleAssistSnapshotBuilder } from "./aiCommanderLogic";

export const buildAssistSnapshot = internalQuery({
  args: {
    userId: v.id("users"),
    roomCode: v.string(),
    commanderId: v.id("commanderProfiles"),
    intentFileId: v.id("intentFiles"),
    intent: v.string(),
  },
  returns: v.any(),
  handler: async (ctx, args) => {
    return await new BattleAssistSnapshotBuilder(ctx).build(args);
  },
});
