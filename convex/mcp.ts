import { v } from "convex/values";
import { defineMcpMutation, defineMcpQuery, type McpToolRegistration } from "convex-mcp-gateway";
import { api } from "./_generated/api";

const PUBLIC_TOOL = {
  public: true,
} as const;

const SECRET_AGENT_KEY = {
  public: true,
  auditArgs: { redact: ["agentKey"] },
} as const;

export const initializeInstructions =
  "You are connected to Battle Tanks. Use the lobby tools to find or create a battle, keep the returned agentKey secret, and issue only tank commands for your own tank. Observe battle state through battle_observe; it reports positions, velocities, bearings, aim, health, projectiles, and recent impact forces without disclosing any player's queued commands.";

export const tools: McpToolRegistration[] = [
  defineMcpQuery({
    name: "battle_list_lobbies",
    description: "List available Battle Tanks lobbies. Currently returns the PvP lobby.",
    fn: api.mcpGame.listLobbies,
    args: {},
    metadata: PUBLIC_TOOL,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }),
  defineMcpQuery({
    name: "battle_list_games",
    description: "List open or active games in a lobby. Finished games are intentionally hidden.",
    fn: api.mcpGame.listGames,
    args: {
      lobbyId: v.optional(v.string()),
    },
    metadata: PUBLIC_TOOL,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }),
  defineMcpMutation({
    name: "battle_create_game",
    description: "Create a new Battle Tanks game as an AI commander. The returned agentKey is secret and is needed to control that tank.",
    fn: api.mcpGame.createGame,
    args: {
      agentName: v.string(),
      battleName: v.optional(v.string()),
      roomCode: v.optional(v.string()),
    },
    metadata: PUBLIC_TOOL,
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }),
  defineMcpMutation({
    name: "battle_join_game",
    description: "Join an existing Battle Tanks game as an AI commander. The returned agentKey is secret and is needed to control that tank.",
    fn: api.mcpGame.joinGame,
    args: {
      roomCode: v.string(),
      agentName: v.string(),
    },
    metadata: PUBLIC_TOOL,
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }),
  defineMcpMutation({
    name: "battle_issue_commands",
    description: "Queue or extend tank commands for the AI's own tank. Commands support semicolon-separated input: bear/b <00-36>, move/m <-10..10> squares, aim/a <00-36> to hold absolute turret aim, elev/e, pow/p, fire/f, ret/r to return turret to hull bearing.",
    fn: api.mcpGame.issueCommands,
    args: {
      roomCode: v.string(),
      agentKey: v.string(),
      commands: v.array(v.string()),
    },
    metadata: SECRET_AGENT_KEY,
    annotations: {
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  }),
  defineMcpQuery({
    name: "battle_observe",
    description: "Observe the battle state without revealing any queued commands. With agentKey, includes own elevation, cannon power, and remaining move distance.",
    fn: api.mcpGame.observeBattle,
    args: {
      roomCode: v.string(),
      agentKey: v.optional(v.string()),
    },
    metadata: SECRET_AGENT_KEY,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }),
  defineMcpQuery({
    name: "battle_recent_collisions",
    description: "Read recent collision impact forces and damage for a battle.",
    fn: api.mcpGame.recentCollisions,
    args: {
      roomCode: v.string(),
      limit: v.optional(v.number()),
    },
    metadata: PUBLIC_TOOL,
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  }),
];
