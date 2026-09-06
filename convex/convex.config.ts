import { defineApp } from "convex/server";
import mcpGateway from "convex-mcp-gateway/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";

const app = defineApp();
app.use(mcpGateway);
app.use(staticHosting);

export default app;
