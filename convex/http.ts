import { httpRouter } from "convex/server";
import { McpGateway, type McpAuthorizerHandler } from "convex-mcp-gateway";
import { auth } from "./auth";
import { components } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { initializeInstructions, tools } from "./mcp";

const http = httpRouter();
const gateway = new McpGateway(components.mcpGateway);

const authorize: McpAuthorizerHandler = async (_ctx, { toolMetadata }) => {
  const meta = (toolMetadata ?? {}) as { public?: boolean };
  if (meta.public) {
    return { allowed: true };
  }
  return { allowed: false, reason: "Unauthorized" };
};

const mcp = httpAction(async (ctx, request) =>
  gateway.handleMcpRequest(ctx, request, {
    authorize,
    tools,
    initializeInstructions,
    serverInfo: {
      name: "battle-tanks",
      title: "Battle Tanks",
      version: "0.1.0",
      description: "MCP controls for the Battle Tanks realtime Convex game.",
    },
  }),
);

auth.addHttpRoutes(http);

for (const path of ["/mcp/", "/mcp"]) {
  http.route({ path, method: "POST", handler: mcp });
  http.route({ path, method: "GET", handler: mcp });
  http.route({ path, method: "DELETE", handler: mcp });
}

export default http;
