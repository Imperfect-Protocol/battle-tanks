import {
  BOARD_SIZE,
  DEFAULT_FIRE_ANGLE_DEGREES,
  DEFAULT_FIRE_POWER,
  UNITS_PER_SQUARE,
  angleFromDirection,
  distanceBetween,
  normalizeOrderCommand,
  normalizeRoom,
  roundForStorage,
  shortestAngleDelta,
  vectorLength,
} from "./gameCore";

export const AI_COMMANDER_LIMITS = {
  maxIntentFileBytes: 24_000,
  recentIntentFileLimit: 5,
} as const;

const DEFAULT_NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
const DEFAULT_NEBIUS_MODEL = "google/gemma-3-27b-it";

type Vector = {
  x: number;
  y: number;
};

type DirectionLike = number | "north" | "east" | "south" | "west";

type TankLike = {
  position: Vector;
  velocity: Vector;
  hullDirection: DirectionLike;
  turretDirection: DirectionLike;
  launchAngle?: number;
  cannonPower?: number;
  lastFirePower?: number;
  health: number;
};

type AssistSnapshot = {
  intent: string;
  derived?: {
    bearingToOpponent?: number;
    leftFlankBearing?: number;
    rightFlankBearing?: number;
    distanceSquares?: number;
  };
  me?: {
    aim?: number;
  };
};

type TokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

export class IntentFilePolicy {
  cleanFilename(filename: string) {
    return filename.trim().replace(/[^\w .-]/g, "").slice(0, 80) || "commander-intents.txt";
  }

  measureSize(content: string) {
    return new TextEncoder().encode(content).length;
  }

  prepare(filename: string, content: string) {
    const preparedContent = content.trim();
    const preparedFilename = this.cleanFilename(filename);
    const size = this.measureSize(preparedContent);

    if (!preparedContent) {
      throw new Error("Intent file is empty");
    }
    if (size > AI_COMMANDER_LIMITS.maxIntentFileBytes) {
      throw new Error("Intent file is too large");
    }

    return {
      filename: preparedFilename,
      content: preparedContent,
      size,
    };
  }

  toSummary(file: { _id: any; filename: string; size: number; createdAt: number; updatedAt: number }) {
    return {
      id: file._id,
      filename: file.filename,
      size: file.size,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
    };
  }
}

export class BattleAssistSnapshotBuilder {
  constructor(private ctx: any) {}

  async build(args: {
    userId: any;
    roomCode: string;
    commanderId: any;
    intentFileId: any;
    intent: string;
  }) {
    const commander = await this.ctx.db.get(args.commanderId);
    if (!commander || commander.userId !== args.userId) {
      throw new Error("Commander not found");
    }

    const intentFile = await this.ctx.db.get(args.intentFileId);
    if (!intentFile || intentFile.userId !== args.userId) {
      throw new Error("Intent file not found");
    }

    const match = await this.ctx.db
      .query("matches")
      .withIndex("by_room_code", (q: any) => q.eq("roomCode", normalizeRoom(args.roomCode)))
      .unique();
    if (!match) {
      throw new Error("Battle not found");
    }

    const players = await this.ctx.db
      .query("players")
      .withIndex("by_match", (q: any) => q.eq("matchId", match._id))
      .take(2);
    const ownPlayer = players.find((player: any) => player.commanderId === args.commanderId);
    if (!ownPlayer) {
      throw new Error("Join the battle before using AI commands");
    }

    const tanks = await this.ctx.db
      .query("tanks")
      .withIndex("by_match", (q: any) => q.eq("matchId", match._id))
      .take(2);
    const ownTank = tanks.find((tank: any) => tank.playerId === ownPlayer._id);
    const opponentTank = tanks.find((tank: any) => tank.playerId !== ownPlayer._id);
    if (!ownTank || !opponentTank) {
      throw new Error("Both tanks must be present");
    }

    const opponentPlayer = players.find((player: any) => player._id === opponentTank.playerId);
    const bearingToOpponent = this.bearingBetween(ownTank.position, opponentTank.position);
    const bearingFromOpponent = this.bearingBetween(opponentTank.position, ownTank.position);

    return {
      intent: args.intent.trim(),
      doctrine: {
        filename: intentFile.filename,
        content: intentFile.content,
      },
      grammar: "bear/b <0-360>; move/m <-10..10>; aim/a <0-360>; elev/e <10-60>; pow/p <10-100>; fire/f; ret/r",
      board: {
        sizeSquares: BOARD_SIZE,
        unitsPerSquare: UNITS_PER_SQUARE,
      },
      me: this.tankSnapshot(ownPlayer.name, ownTank),
      opponent: this.tankSnapshot(opponentPlayer?.name ?? "Opponent", opponentTank),
      derived: {
        vectorToOpponent: {
          x: opponentTank.position.x - ownTank.position.x,
          y: opponentTank.position.y - ownTank.position.y,
        },
        distanceSquares: roundForStorage(distanceBetween(ownTank.position, opponentTank.position) / UNITS_PER_SQUARE),
        bearingToOpponent,
        leftFlankBearing: roundForStorage((bearingToOpponent + 270) % 360),
        rightFlankBearing: roundForStorage((bearingToOpponent + 90) % 360),
        opponentAimErrorToMe: roundForStorage(
          Math.abs(shortestAngleDelta(angleFromDirection(opponentTank.turretDirection), bearingFromOpponent)),
        ),
        wallDistancesSquares: {
          north: roundForStorage((ownTank.position.y - UNITS_PER_SQUARE) / UNITS_PER_SQUARE),
          east: roundForStorage(((BOARD_SIZE - 1) * UNITS_PER_SQUARE - ownTank.position.x) / UNITS_PER_SQUARE),
          south: roundForStorage(((BOARD_SIZE - 1) * UNITS_PER_SQUARE - ownTank.position.y) / UNITS_PER_SQUARE),
          west: roundForStorage((ownTank.position.x - UNITS_PER_SQUARE) / UNITS_PER_SQUARE),
        },
      },
    };
  }

  private tankSnapshot(name: string, tank: TankLike) {
    return {
      name,
      position: tank.position,
      velocity: tank.velocity,
      speedSquaresPerSecond: roundForStorage(vectorLength(tank.velocity) / UNITS_PER_SQUARE),
      bearing: angleFromDirection(tank.hullDirection),
      aim: angleFromDirection(tank.turretDirection),
      elevation: tank.launchAngle ?? DEFAULT_FIRE_ANGLE_DEGREES,
      power: tank.cannonPower ?? tank.lastFirePower ?? DEFAULT_FIRE_POWER,
      hp: tank.health,
    };
  }

  private bearingBetween(from: Vector, to: Vector) {
    return roundForStorage((((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI) + 90 + 360) % 360);
  }
}

export class CommandLineInterpreter {
  readAssistantText(body: any) {
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content.map((part) => part?.text ?? "").join("\n");
    }
    throw new Error("Nebius response did not include commands");
  }

  readCommandLine(text: string) {
    const trimmed = text.trim();
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.commands === "string") {
        return parsed.commands;
      }
    } catch {
      // Some models ignore JSON-only instructions; validate plain text below.
    }
    return trimmed.replace(/^```(?:json|text)?/i, "").replace(/```$/i, "").trim();
  }

  normalize(commandLine: string) {
    const commands = normalizeOrderCommand(commandLine);
    if (commands.length === 0) {
      throw new Error("AI returned incorrect command");
    }
    return commands;
  }
}

export class NebiusCommanderClient {
  private readonly interpreter = new CommandLineInterpreter();

  constructor(private env: Record<string, string | undefined>) {}

  async assist(snapshot: AssistSnapshot, startedAt: number, modelOverride?: string) {
    const model = new NebiusModelConfig(this.env).model(modelOverride);
    const apiKey = this.env.NEBIUS_API_KEY;

    if (!apiKey) {
      const commandLine = this.localPreviewCommand(snapshot);
      const commands = this.interpreter.normalize(commandLine);
      return {
        commandLine,
        commands,
        provider: "local-preview",
        model,
        configured: false,
        latencyMs: Date.now() - startedAt,
        debugInput: new AssistObservationLog(snapshot, modelOverride).toJSON(),
      };
    }

    const endpoint = new NebiusEndpoint(this.env);
    const response: Response = await fetch(endpoint.chatCompletionsUrl(), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens: 160,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: this.systemPrompt() },
          { role: "user", content: JSON.stringify(snapshot) },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(await endpoint.errorMessage(response, model));
    }

    const body: any = await response.json();
    const commandLine = this.interpreter.readCommandLine(this.interpreter.readAssistantText(body));
    const commands = this.interpreter.normalize(commandLine);
    const usage: TokenUsage = body?.usage ?? {};

    return {
      commandLine: commands.join("; "),
      commands,
      provider: "nebius-token-factory",
      model,
      configured: true,
      latencyMs: Date.now() - startedAt,
      ...(Number.isFinite(usage.prompt_tokens) ? { inputTokens: usage.prompt_tokens } : {}),
      ...(Number.isFinite(usage.completion_tokens) ? { outputTokens: usage.completion_tokens } : {}),
      ...this.estimateCost(usage),
      debugInput: new AssistObservationLog(snapshot, modelOverride).toJSON(),
    };
  }

  private systemPrompt() {
    return [
      "You are Battle Tanks AI Commander Assist.",
      "Use the player's doctrine, current battle state, and intent to produce one concise command chain.",
      "Return JSON only: {\"commands\":\"...\"}.",
      "Use only legal commands from the supplied grammar.",
      "Prefer short plans of 1 to 6 commands.",
      "If the intent is impossible or unsafe, return a conservative valid command chain.",
      "Do not explain.",
    ].join("\n");
  }

  private estimateCost(usage: TokenUsage) {
    const input = typeof usage.prompt_tokens === "number" && Number.isFinite(usage.prompt_tokens)
      ? usage.prompt_tokens
      : null;
    const output = typeof usage.completion_tokens === "number" && Number.isFinite(usage.completion_tokens)
      ? usage.completion_tokens
      : null;
    const inputPrice = Number(this.env.NEBIUS_INPUT_PRICE_PER_MILLION ?? "");
    const outputPrice = Number(this.env.NEBIUS_OUTPUT_PRICE_PER_MILLION ?? "");
    if (input === null || output === null || !Number.isFinite(inputPrice) || !Number.isFinite(outputPrice)) {
      return {};
    }
    return {
      estimatedCostUsd: roundForStorage((input / 1_000_000) * inputPrice + (output / 1_000_000) * outputPrice),
    };
  }

  private localPreviewCommand(snapshot: AssistSnapshot) {
    const intent = String(snapshot.intent ?? "").toLowerCase();
    const bearingToOpponent = snapshot.derived?.bearingToOpponent ?? snapshot.me?.aim ?? 0;
    const leftFlankBearing = snapshot.derived?.leftFlankBearing ?? bearingToOpponent;
    const rightFlankBearing = snapshot.derived?.rightFlankBearing ?? bearingToOpponent;
    const distanceSquares = snapshot.derived?.distanceSquares ?? 5;
    const power = Math.max(35, Math.min(100, Math.round(distanceSquares * 18)));

    if (intent.includes("hide") || intent.includes("evade")) {
      return `bear ${leftFlankBearing}; move 2; ret`;
    }
    if (intent.includes("flank right")) {
      return `bear ${rightFlankBearing}; move 2; aim ${bearingToOpponent}`;
    }
    if (intent.includes("flank")) {
      return `bear ${leftFlankBearing}; move 2; aim ${bearingToOpponent}`;
    }
    return `aim ${bearingToOpponent}; elev 45; pow ${power}; fire`;
  }
}

class AssistObservationLog {
  constructor(private snapshot: any, private modelOverride: string | undefined) {}

  toJSON() {
    return {
      intent: this.snapshot.intent,
      grammar: this.snapshot.grammar,
      board: this.snapshot.board,
      ai: {
        sessionModel: this.modelOverride ?? null,
      },
      doctrine: {
        filename: this.snapshot.doctrine?.filename,
      },
      me: this.snapshot.me,
      opponent: this.snapshot.opponent,
      derived: this.snapshot.derived,
    };
  }
}

class NebiusModelConfig {
  constructor(private env: Record<string, string | undefined>) {}

  model(override?: string) {
    const model = override?.trim() || this.env.NEBIUS_MODEL?.trim();
    if (!model || this.isRemovedLlama31Model(model)) {
      return DEFAULT_NEBIUS_MODEL;
    }
    return model;
  }

  private isRemovedLlama31Model(model: string) {
    return model === "Llama-3.1-8B-Instruct" || model === "meta-llama/Llama-3.1-8B-Instruct";
  }
}

class NebiusEndpoint {
  constructor(private env: Record<string, string | undefined>) {}

  chatCompletionsUrl() {
    const url = new URL(`${this.baseUrl()}/chat/completions`);
    const projectId = this.env.NEBIUS_AI_PROJECT_ID?.trim();
    if (projectId) {
      url.searchParams.set("ai_project_id", projectId);
    }
    return url.toString();
  }

  async errorMessage(response: Response, model: string) {
    const body = await this.safeResponseText(response);
    if (response.status === 404) {
      return [
        `Nebius model not found or not enabled: ${model}`,
        "Set NEBIUS_MODEL to an exact id from your Token Factory model catalog.",
        body,
      ].filter(Boolean).join(" ");
    }
    return [`Nebius request failed: ${response.status}`, body].filter(Boolean).join(" ");
  }

  private baseUrl() {
    return (this.env.NEBIUS_BASE_URL ?? DEFAULT_NEBIUS_BASE_URL).replace(/\/+$/, "");
  }

  private async safeResponseText(response: Response) {
    try {
      return (await response.text()).slice(0, 400);
    } catch {
      return "";
    }
  }
}
