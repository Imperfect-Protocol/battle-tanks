import {
  BOARD_SIZE,
  DEFAULT_FIRE_ANGLE_DEGREES,
  DEFAULT_FIRE_POWER,
  FRAME_RATE,
  TANK_COLLISION_CLEARANCE_UNITS,
  TANK_COLLISION_RADIUS_UNITS,
  TANK_LENGTH_UNITS,
  TANK_WIDTH_UNITS,
  UNITS_PER_SQUARE,
  angleFromDirection,
  clamp,
  distanceBetween,
  normalizeOrderCommand,
  normalizeRoom,
  normalizeDegrees,
  roundForStorage,
  shortestAngleDelta,
  vectorFromBearing,
  vectorLength,
} from "./gameCore";
import { BattleDamageModel, ProjectilePhysics, TargetingModel } from "./battlePhysics";

export const AI_COMMANDER_LIMITS = {
  maxIntentFileBytes: 24_000,
  recentIntentFileLimit: 5,
} as const;

const DEFAULT_NEBIUS_BASE_URL = "https://api.tokenfactory.nebius.com/v1";
const DEFAULT_NEBIUS_MODEL = "MiniMaxAI/MiniMax-M3";
const DEFAULT_AI_ORBIT_RADIUS_SQUARES = 3.5;
const DEFAULT_AI_ORBIT_STEP_SQUARES = 1;
const AI_ORBIT_MAX_BEARING_DELTA = 55;

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

type TankSnapshot = {
  name: string;
  position: Vector;
  velocity: Vector;
  speedSquaresPerSecond: number;
  bearing: number;
  aim: number;
  elevation: number;
  power: number;
  hp: number;
};

type IntentPlan = {
  category: string;
  requiredCommandTypes: string[];
  forbiddenCommandTypes: string[];
  recommendedCommands: string;
  reason: string;
};

type AiRequest = {
  mode: "assist" | "plan" | "command" | "review";
  task: string | null;
  tasks: string[];
  completedTask: string | null;
  completedCommands: string[];
};

type AssistSnapshot = {
  intent: string;
  grammar?: string;
  board?: {
    sizeSquares: number;
    unitsPerSquare: number;
  };
  strategy?: {
    filename: string;
    content: string;
  };
  derived?: {
    vectorToOpponent?: Vector;
    indicators?: {
      aimImpact?: {
        x: number;
        y: number;
        squareX: number;
        squareY: number;
      };
      target?: {
        x: number;
        y: number;
        squareX: number;
        squareY: number;
      };
      flightTicks?: number;
      flightMs?: number;
    };
    fireSolutions?: {
      aim: number;
      elevation: number;
      power: number;
      predictedTarget: {
        x: number;
        y: number;
        squareX: number;
        squareY: number;
      };
      predictedImpact: {
        x: number;
        y: number;
        squareX: number;
        squareY: number;
      };
      missDistance: number;
      missSquares: number;
      flightTicks: number;
      flightMs: number;
      command: string;
    }[];
    bearingToOpponent?: number;
    leftFlankBearing?: number;
    rightFlankBearing?: number;
    distanceSquares?: number;
    opponentAimErrorToMe?: number;
    wallDistancesSquares?: {
      north: number;
      east: number;
      south: number;
      west: number;
    };
  };
  me?: TankSnapshot;
  opponent?: TankSnapshot;
  intentPlan?: IntentPlan;
  aiRequest?: AiRequest;
};

type TokenUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
};

type NebiusChatMessage = {
  role: "system" | "user";
  content: string;
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
  private readonly targeting = new TargetingModel();

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
    const indicators = this.targeting.indicators(
      this.tankStateForPhysics(ownTank),
      this.tankStateForPhysics(opponentTank),
      BOARD_SIZE,
    );
    const fireSolutions = this.targeting.fireSolutions(
      this.tankStateForPhysics(ownTank),
      this.tankStateForPhysics(opponentTank),
      BOARD_SIZE,
    );

    const snapshot = {
      intent: args.intent.trim(),
      strategy: {
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
        indicators,
        fireSolutions,
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
    return {
      ...snapshot,
      intentPlan: new CommanderIntentPlanner().plan(snapshot),
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

  private tankStateForPhysics(tank: any) {
    return {
      position: tank.position,
      velocity: tank.velocity,
      hullDirection: angleFromDirection(tank.hullDirection),
      turretDirection: angleFromDirection(tank.turretDirection),
      launchAngle: tank.launchAngle,
      cannonPower: tank.cannonPower,
      lastFirePower: tank.lastFirePower,
      tankSpec: tank.tankSpec,
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
    const parsed = this.readJsonObject(text);
    if (typeof parsed?.commands === "string") {
      return parsed.commands;
    }

    const trimmed = text.trim();
    return trimmed.replace(/^```(?:json|text)?/i, "").replace(/```$/i, "").trim();
  }

  readTaskList(text: string) {
    const parsed = this.readJsonObject(text);
    const tasks: unknown[] = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    return tasks
      .filter((task): task is string => typeof task === "string")
      .map((task) => task.trim())
      .filter(Boolean)
      .slice(0, 6);
  }

  readAchieved(text: string) {
    const parsed = this.readJsonObject(text);
    return parsed?.achieved === true;
  }

  readStopReason(text: string) {
    const parsed = this.readJsonObject(text);
    return typeof parsed?.stopReason === "string" ? parsed.stopReason.trim().slice(0, 160) : "";
  }

  private readJsonObject(text: string) {
    const trimmed = text.trim().replace(/^```(?:json|text)?/i, "").replace(/```$/i, "").trim();
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
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
  private readonly prompt = new BattleTanksCommanderPrompt();
  private readonly intentGuard = new CommanderIntentGuard();

  constructor(private env: Record<string, string | undefined>) {}

  async assist(snapshot: AssistSnapshot, startedAt: number, modelOverride?: string) {
    const model = new NebiusModelConfig(this.env).model(modelOverride);
    const apiKey = this.env.NEBIUS_API_KEY;
    const messages = this.prompt.messages(snapshot);

    if (!apiKey) {
      const result = this.localPreviewResult(snapshot);
      const previewReply = new LocalPreviewReply(result).toJSON();
      return {
        ...result,
        provider: "local-preview",
        model,
        configured: false,
        latencyMs: Date.now() - startedAt,
        debugInput: new AssistObservationLog(snapshot, modelOverride).toJSON(),
        debugPrompt: messages,
        debugReply: previewReply,
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
        messages,
      }),
    });

    if (!response.ok) {
      throw new Error(await endpoint.errorMessage(response, model));
    }

    const body: any = await response.json();
    const result = this.resultFromAssistant(snapshot, this.interpreter.readAssistantText(body));
    const usage: TokenUsage = body?.usage ?? {};

    return {
      ...result,
      provider: "nebius-token-factory",
      model,
      configured: true,
      latencyMs: Date.now() - startedAt,
      ...(Number.isFinite(usage.prompt_tokens) ? { inputTokens: usage.prompt_tokens } : {}),
      ...(Number.isFinite(usage.completion_tokens) ? { outputTokens: usage.completion_tokens } : {}),
      ...this.estimateCost(usage),
      debugInput: new AssistObservationLog(snapshot, modelOverride).toJSON(),
      debugPrompt: messages,
      debugReply: body,
    };
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
    const planned = this.snapshotForCommand(snapshot);
    if (planned.intentPlan?.recommendedCommands) {
      return planned.intentPlan.recommendedCommands;
    }

    const intent = String(planned.intent ?? "").toLowerCase();
    const bearingToOpponent = planned.derived?.bearingToOpponent ?? planned.me?.aim ?? 0;
    const leftFlankBearing = planned.derived?.leftFlankBearing ?? bearingToOpponent;
    const rightFlankBearing = planned.derived?.rightFlankBearing ?? bearingToOpponent;
    const distanceSquares = planned.derived?.distanceSquares ?? 5;
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

  private localPreviewResult(snapshot: AssistSnapshot) {
    const mode = snapshot.aiRequest?.mode ?? "assist";
    if (mode === "plan") {
      return {
        commandLine: "",
        commands: [],
        tasks: new CommanderMissionTaskPlanner().plan(snapshot),
      };
    }
    if (mode === "review") {
      return {
        commandLine: "",
        commands: [],
        tasks: [],
        achieved: false,
        stopReason: "Local preview keeps the mission open until Nebius is configured.",
      };
    }
    return this.commandResult(snapshot, this.localPreviewCommand(snapshot));
  }

  private resultFromAssistant(snapshot: AssistSnapshot, assistantText: string) {
    const mode = snapshot.aiRequest?.mode ?? "assist";
    if (mode === "plan") {
      const tasks = this.interpreter.readTaskList(assistantText);
      return {
        commandLine: "",
        commands: [],
        tasks: new CommanderMissionTaskPlanner().guard(snapshot, tasks),
      };
    }
    if (mode === "review") {
      const achieved = this.interpreter.readAchieved(assistantText);
      return {
        commandLine: "",
        commands: [],
        tasks: achieved ? [] : new CommanderMissionTaskPlanner().guard(snapshot, this.interpreter.readTaskList(assistantText)),
        achieved,
        stopReason: this.interpreter.readStopReason(assistantText),
      };
    }
    return this.commandResult(snapshot, this.interpreter.readCommandLine(assistantText));
  }

  private commandResult(snapshot: AssistSnapshot, commandLine: string) {
    const planned = this.snapshotForCommand(snapshot);
    const commands = this.interpreter.normalize(commandLine);
    const guarded = this.intentGuard.guard(planned, commands);
    return {
      commandLine: guarded.commands.join("; "),
      commands: guarded.commands,
    };
  }

  private snapshotForCommand(snapshot: AssistSnapshot): AssistSnapshot {
    if (snapshot.aiRequest?.mode !== "command" || !snapshot.aiRequest.task) {
      return snapshot;
    }
    const planned = {
      ...snapshot,
      intent: snapshot.aiRequest.task,
    };
    return {
      ...planned,
      intentPlan: new CommanderIntentPlanner().mergeParentConstraints(
        new CommanderIntentPlanner().plan(planned),
        snapshot.intentPlan,
      ),
    };
  }

}

class LocalPreviewReply {
  constructor(private result: { commandLine: string; tasks?: string[]; achieved?: boolean; stopReason?: string }) {}

  toJSON() {
    return {
      choices: [
        {
          message: {
            content: JSON.stringify({
              commands: this.result.commandLine,
              tasks: this.result.tasks ?? [],
              achieved: this.result.achieved ?? false,
              stopReason: this.result.stopReason ?? "",
            }),
          },
        },
      ],
    };
  }
}

class CommanderStrategyDirectives {
  constructor(private readonly snapshot: AssistSnapshot) {}

  orbitRadiusSquares() {
    return this.numberNear(/\b(?:orbit|circle|flank|around|distance|radius)\b.{0,40}\b(\d+(?:\.\d+)?)\s*(?:sq|square|squares)\b/i, 2.5, 5, DEFAULT_AI_ORBIT_RADIUS_SQUARES);
  }

  orbitStepSquares() {
    return this.numberNear(/\b(?:step|move)\b.{0,24}\b(\d+(?:\.\d+)?)\s*(?:sq|square|squares)\b/i, 0, 2, DEFAULT_AI_ORBIT_STEP_SQUARES);
  }

  attackCommand(fallbackBearing: number) {
    const solution = this.preferredFireSolution();
    if (solution) {
      return solution.command;
    }
    return `aim ${fallbackBearing}; elev ${this.preferredElevation(45)}; pow ${this.preferredPower(80)}; fire`;
  }

  aimCommand(fallbackBearing: number) {
    const solution = this.preferredFireSolution();
    if (solution) {
      return `aim ${solution.aim}; elev ${solution.elevation}; pow ${solution.power}`;
    }
    return `aim ${fallbackBearing}; elev ${this.preferredElevation(45)}; pow ${this.preferredPower(80)}`;
  }

  private preferredFireSolution() {
    const solutions = this.snapshot.derived?.fireSolutions ?? [];
    const elevation = this.optionalNumberNear(/\b(?:prefer|preferred|use|favor|favour)\b.{0,24}\b(?:elev|elevation|angle)\b.{0,12}\b(\d+(?:\.\d+)?)\b/i);
    const power = this.optionalNumberNear(/\b(?:prefer|preferred|use|favor|favour)\b.{0,24}\b(?:pow|power)\b.{0,12}\b(\d+(?:\.\d+)?)\b/i);
    return [...solutions].sort((left, right) => {
      const leftPenalty = this.firePreferencePenalty(left, elevation, power);
      const rightPenalty = this.firePreferencePenalty(right, elevation, power);
      return leftPenalty - rightPenalty || left.missDistance - right.missDistance;
    })[0] ?? null;
  }

  private firePreferencePenalty(solution: { elevation: number; power: number; missDistance: number }, elevation: number | null, power: number | null) {
    return solution.missDistance +
      (elevation === null ? 0 : Math.abs(solution.elevation - elevation) * 90) +
      (power === null ? 0 : Math.abs(solution.power - power) * 18);
  }

  private preferredElevation(fallback: number) {
    return this.numberNear(/\b(?:prefer|preferred|use|favor|favour)\b.{0,24}\b(?:elev|elevation|angle)\b.{0,12}\b(\d+(?:\.\d+)?)\b/i, 10, 60, fallback);
  }

  private preferredPower(fallback: number) {
    return this.numberNear(/\b(?:prefer|preferred|use|favor|favour)\b.{0,24}\b(?:pow|power)\b.{0,12}\b(\d+(?:\.\d+)?)\b/i, 10, 100, fallback);
  }

  private numberNear(pattern: RegExp, min: number, max: number, fallback: number) {
    const value = this.optionalNumberNear(pattern);
    return value === null ? fallback : clamp(value, min, max);
  }

  private optionalNumberNear(pattern: RegExp) {
    const match = this.text().match(pattern);
    const value = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(value) ? value : null;
  }

  private text() {
    return [
      this.snapshot.strategy?.content ?? "",
      this.snapshot.intent ?? "",
    ].join("\n");
  }
}

class CommanderIntentPlanner {
  plan(snapshot: AssistSnapshot): IntentPlan {
    const intent = String(snapshot.intent ?? "").toLowerCase();
    const classifier = new CommanderIntentClassifier(intent);
    const directives = new CommanderStrategyDirectives(snapshot);
    const bearingToOpponent = snapshot.derived?.bearingToOpponent ?? snapshot.me?.aim ?? 0;
    const leftFlankBearing = snapshot.derived?.leftFlankBearing ?? bearingToOpponent;
    const rightFlankBearing = snapshot.derived?.rightFlankBearing ?? bearingToOpponent;
    const attackCommand = directives.attackCommand(bearingToOpponent);
    const aimCommand = directives.aimCommand(bearingToOpponent);

    if (classifier.wantsReverse) {
      return this.intentPlan("reverse", ["move"], ["fire"], `move -2`, "Move backward; do not fire for reverse intent.");
    }

    if (classifier.wantsAway && classifier.wantsAttack) {
      const evade = this.safeMovement(snapshot, this.escapeBearing(snapshot), 2);
      return this.intentPlan(
        "evade-attack",
        ["bear", "move", "aim", "elev", "pow", "fire"],
        [],
        `bear ${evade.bearing}; move ${evade.squares}; ${attackCommand}`,
        "Move away from opponent, then fire using the best fire-control solution.",
      );
    }

    if (classifier.wantsAway) {
      const evade = this.safeMovement(snapshot, this.escapeBearing(snapshot), 2);
      return this.intentPlan(
        "evade",
        ["bear", "move"],
        ["fire"],
        `bear ${evade.bearing}; move ${evade.squares}; aim ${bearingToOpponent}`,
        "Move away from opponent while keeping turret aimed at them; do not fire.",
      );
    }

    const navigation = new CommanderNavigationIntent(snapshot).read(classifier);
    if (navigation && classifier.wantsAttack) {
      const safeNavigation = this.safeMovement(snapshot, navigation.bearing, navigation.squares);
      return this.intentPlan(
        "navigate-attack",
        ["bear", "move", "aim", "elev", "pow", "fire"],
        [],
        `bear ${safeNavigation.bearing}; move ${safeNavigation.squares}; ${attackCommand}`,
        `${navigation.reason}, then fire using the best fire-control solution.`,
      );
    }

    if (navigation && classifier.wantsAim) {
      const safeNavigation = this.safeMovement(snapshot, navigation.bearing, navigation.squares);
      return this.intentPlan(
        "navigate-aim",
        ["bear", "move", "aim"],
        ["fire"],
        `bear ${safeNavigation.bearing}; move ${safeNavigation.squares}; ${aimCommand}`,
        `${navigation.reason}, then aim at the predicted target; do not fire.`,
      );
    }

    if (navigation) {
      const safeNavigation = this.safeMovement(snapshot, navigation.bearing, navigation.squares);
      return this.intentPlan(
        "navigate",
        ["bear", "move"],
        ["fire"],
        `bear ${safeNavigation.bearing}; move ${safeNavigation.squares}`,
        `${navigation.reason}; do not fire.`,
      );
    }

    if (classifier.wantsFlank && classifier.wantsAttack) {
      const flank = this.safeFlankMovement(snapshot, classifier.wantsFlankRight ? rightFlankBearing : leftFlankBearing, classifier.wantsFlankRight ? leftFlankBearing : rightFlankBearing);
      const category = classifier.wantsFlankRight ? "flank-right-attack" : "flank-left-attack";
      return this.intentPlan(
        category,
        ["bear", "move", "aim", "elev", "pow", "fire"],
        [],
        `bear ${flank.bearing}; move ${flank.squares}; ${attackCommand}`,
        "Move around opponent on a tangent, then fire using the best fire-control solution.",
      );
    }

    if (classifier.wantsFlankRight) {
      const flank = this.safeFlankMovement(snapshot, rightFlankBearing, leftFlankBearing);
      return this.intentPlan("flank-right", ["bear", "move"], ["fire"], `bear ${flank.bearing}; move ${flank.squares}; aim ${bearingToOpponent}`, "Move tangent to opponent on the right side; do not fire.");
    }

    if (classifier.wantsFlank) {
      const flank = this.safeFlankMovement(snapshot, leftFlankBearing, rightFlankBearing);
      return this.intentPlan("flank-left", ["bear", "move"], ["fire"], `bear ${flank.bearing}; move ${flank.squares}; aim ${bearingToOpponent}`, "Move tangent to opponent on the left side; do not fire.");
    }

    if (classifier.wantsMovement && classifier.wantsAttack) {
      const approach = this.safeMovement(snapshot, bearingToOpponent, this.approachSquares(snapshot));
      return this.intentPlan(
        "advance-attack",
        ["bear", "move", "aim", "elev", "pow", "fire"],
        [],
        `bear ${approach.bearing}; move ${approach.squares}; ${attackCommand}`,
        "Move toward opponent, aim with best fire-control solution, then fire.",
      );
    }

    if (classifier.wantsMovement) {
      const approach = this.safeMovement(snapshot, bearingToOpponent, this.approachSquares(snapshot));
      return this.intentPlan(
        "approach",
        ["bear", "move"],
        ["fire"],
        `bear ${approach.bearing}; move ${approach.squares}`,
        "Move toward opponent using current bearingToOpponent; do not fire for movement-only intent.",
      );
    }

    if (classifier.wantsAim && !classifier.wantsAttack) {
      return this.intentPlan(
        "aim",
        ["aim"],
        ["fire"],
        aimCommand,
        "Aim at the predicted target and set elevation/power if useful; do not fire.",
      );
    }

    return this.intentPlan("attack", ["aim", "elev", "pow", "fire"], [], attackCommand, "Attack using the best precomputed fire solution.");
  }

  mergeParentConstraints(plan: IntentPlan, parentPlan?: IntentPlan): IntentPlan {
    if (!parentPlan) {
      return plan;
    }

    const forbidden = Array.from(new Set([...plan.forbiddenCommandTypes, ...parentPlan.forbiddenCommandTypes]));
    if (forbidden.length === plan.forbiddenCommandTypes.length) {
      return plan;
    }

    return {
      ...plan,
      forbiddenCommandTypes: forbidden,
      recommendedCommands: new CommanderCommandPolicy().withoutForbidden(plan.recommendedCommands, forbidden),
    };
  }

  private intentPlan(
    category: string,
    requiredCommandTypes: string[],
    forbiddenCommandTypes: string[],
    recommendedCommands: string,
    reason: string,
  ) {
    return {
      category,
      requiredCommandTypes,
      forbiddenCommandTypes,
      recommendedCommands,
      reason,
    };
  }

  private approachSquares(snapshot: AssistSnapshot) {
    const distance = snapshot.derived?.distanceSquares ?? 5;
    return Math.max(1, Math.min(3, Math.floor(distance - 2)));
  }

  private escapeBearing(snapshot: AssistSnapshot) {
    const bearing = snapshot.derived?.bearingToOpponent ?? 0;
    return roundForStorage((bearing + 180) % 360);
  }

  private safeFlankMovement(snapshot: AssistSnapshot, preferredBearing: number, alternateBearing: number) {
    const orbit = new CommanderOrbitPlanner(snapshot).movement(preferredBearing, alternateBearing);
    if (orbit.squares >= 1) {
      return orbit;
    }

    const preferred = this.safeMovement(snapshot, preferredBearing, DEFAULT_AI_ORBIT_STEP_SQUARES);
    if (preferred.squares >= 1) {
      return preferred;
    }

    const alternate = this.safeMovement(snapshot, alternateBearing, DEFAULT_AI_ORBIT_STEP_SQUARES);
    if (alternate.squares >= 1) {
      return alternate;
    }

    return this.safeMovement(snapshot, new CommanderMovementSafety(snapshot).openSpaceBearing(), DEFAULT_AI_ORBIT_STEP_SQUARES);
  }

  private safeMovement(snapshot: AssistSnapshot, bearing: number, requestedSquares: number) {
    return new CommanderMovementSafety(snapshot).movement(bearing, requestedSquares);
  }

  private aimCommand(snapshot: AssistSnapshot, fallbackBearing: number) {
    const best = snapshot.derived?.fireSolutions?.[0];
    if (best) {
      return `aim ${best.aim}; elev ${best.elevation}; pow ${best.power}`;
    }
    return `aim ${fallbackBearing}; elev 45; pow 80`;
  }
}

class CommanderMovementSafety {
  constructor(private readonly snapshot: AssistSnapshot) {}

  movement(bearing: number, requestedSquares: number) {
    const maxSquares = this.maxSafeMoveSquares(bearing);
    return {
      bearing: roundForStorage(normalizeDegrees(bearing)),
      squares: Math.max(0, Math.min(requestedSquares, maxSquares)),
    };
  }

  openSpaceBearing() {
    const position = this.snapshot.me?.position;
    if (!position) {
      return this.snapshot.derived?.bearingToOpponent ?? 0;
    }

    const min = UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS;
    const max = (BOARD_SIZE - 1) * UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS;
    const x = position.x < min + UNITS_PER_SQUARE ? 1 : position.x > max - UNITS_PER_SQUARE ? -1 : 0;
    const y = position.y < min + UNITS_PER_SQUARE ? 1 : position.y > max - UNITS_PER_SQUARE ? -1 : 0;
    if (x === 0 && y === 0) {
      return this.snapshot.derived?.bearingToOpponent ?? 0;
    }
    return roundForStorage((((Math.atan2(y, x) * 180) / Math.PI) + 90 + 360) % 360);
  }

  private maxSafeMoveSquares(bearing: number) {
    const position = this.snapshot.me?.position;
    if (!position) {
      return 1;
    }

    const direction = vectorFromBearing(bearing, 1);
    const min = UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS;
    const max = (BOARD_SIZE - 1) * UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS;
    const distances = [];
    if (direction.x < -0.001) {
      distances.push((position.x - min) / (-direction.x));
    }
    if (direction.x > 0.001) {
      distances.push((max - position.x) / direction.x);
    }
    if (direction.y < -0.001) {
      distances.push((position.y - min) / (-direction.y));
    }
    if (direction.y > 0.001) {
      distances.push((max - position.y) / direction.y);
    }

    const wallLimit = Math.max(0, Math.min(...distances) / UNITS_PER_SQUARE - 0.2);
    const tankLimit = this.maxSafeTankDistanceSquares(bearing);
    return Math.floor(Math.max(0, Math.min(wallLimit, tankLimit, 3)));
  }

  private maxSafeTankDistanceSquares(bearing: number) {
    if (!this.snapshot.me?.position || !this.snapshot.opponent?.position) {
      return 3;
    }

    const direction = vectorFromBearing(bearing, 1);
    const relative = {
      x: this.snapshot.opponent.position.x - this.snapshot.me.position.x,
      y: this.snapshot.opponent.position.y - this.snapshot.me.position.y,
    };
    const projection = relative.x * direction.x + relative.y * direction.y;
    if (projection <= 0) {
      return 3;
    }

    const perpendicularDistance = Math.hypot(relative.x - direction.x * projection, relative.y - direction.y * projection);
    const minDistance = TANK_COLLISION_RADIUS_UNITS * 2 + TANK_COLLISION_CLEARANCE_UNITS;
    if (perpendicularDistance >= minDistance) {
      return 3;
    }

    const alongCollision = projection - Math.sqrt(minDistance * minDistance - perpendicularDistance * perpendicularDistance);
    return Math.max(0, alongCollision / UNITS_PER_SQUARE - 0.25);
  }
}

class CommanderOrbitPlanner {
  constructor(private readonly snapshot: AssistSnapshot) {}

  movement(preferredTangent: number, alternateTangent: number) {
    const preferred = this.safeOrbitMovement(preferredTangent);
    const alternate = this.safeOrbitMovement(alternateTangent);
    const movement = this.betterMovement(preferred, alternate);
    return {
      bearing: movement.bearing,
      squares: movement.squares,
    };
  }

  private safeOrbitMovement(tangentBearing: number) {
    const orbitBearing = this.orbitBearing(tangentBearing);
    return new CommanderMovementSafety(this.snapshot).movement(orbitBearing, new CommanderStrategyDirectives(this.snapshot).orbitStepSquares());
  }

  private orbitBearing(tangentBearing: number) {
    const bearingToOpponent = this.snapshot.derived?.bearingToOpponent ?? this.snapshot.me?.bearing ?? tangentBearing;
    const distance = this.snapshot.derived?.distanceSquares ?? DEFAULT_AI_ORBIT_RADIUS_SQUARES;
    const radiusError = new CommanderStrategyDirectives(this.snapshot).orbitRadiusSquares() - distance;
    const radialWeight = Math.min(0.7, Math.abs(radiusError) / 1.5);
    const radialBearing = radiusError > 0 ? normalizeDegrees(bearingToOpponent + 180) : bearingToOpponent;
    const tangent = vectorFromBearing(tangentBearing, 1);
    const radial = vectorFromBearing(radialBearing, radialWeight);
    const targetBearing = this.bearingFromVector({
      x: tangent.x + radial.x,
      y: tangent.y + radial.y,
    }, tangentBearing);
    return this.smoothBearing(targetBearing);
  }

  private smoothBearing(targetBearing: number) {
    const currentBearing = this.snapshot.me?.bearing ?? targetBearing;
    const delta = shortestAngleDelta(currentBearing, targetBearing);
    return roundForStorage(normalizeDegrees(currentBearing + clamp(delta, -AI_ORBIT_MAX_BEARING_DELTA, AI_ORBIT_MAX_BEARING_DELTA)));
  }

  private betterMovement(
    preferred: { bearing: number; squares: number },
    alternate: { bearing: number; squares: number },
  ) {
    if (preferred.squares !== alternate.squares) {
      return preferred.squares > alternate.squares ? preferred : alternate;
    }

    const currentBearing = this.snapshot.me?.bearing ?? preferred.bearing;
    return Math.abs(shortestAngleDelta(currentBearing, preferred.bearing)) <= Math.abs(shortestAngleDelta(currentBearing, alternate.bearing))
      ? preferred
      : alternate;
  }

  private bearingFromVector(vector: Vector, fallbackBearing: number) {
    if (vectorLength(vector) <= 0.0001) {
      return fallbackBearing;
    }
    return roundForStorage((((Math.atan2(vector.y, vector.x) * 180) / Math.PI) + 90 + 360) % 360);
  }
}

class CommanderNavigationIntent {
  constructor(private readonly snapshot: AssistSnapshot) {}

  read(classifier: CommanderIntentClassifier) {
    const centerBearing = this.centerBearing(classifier);
    if (centerBearing !== null) {
      return {
        bearing: centerBearing,
        squares: this.centerMoveSquares(),
        reason: "Move toward the arena center",
      };
    }

    const compassBearing = classifier.compassBearing;
    if (compassBearing !== null) {
      return {
        bearing: compassBearing,
        squares: 2,
        reason: `Move ${classifier.compassLabel}`,
      };
    }

    return null;
  }

  private centerBearing(classifier: CommanderIntentClassifier) {
    if (!classifier.wantsCenter || !this.snapshot.me?.position) {
      return null;
    }

    const center = (this.snapshot.board?.sizeSquares ?? BOARD_SIZE) * UNITS_PER_SQUARE * 0.5;
    return this.bearingBetween(this.snapshot.me.position, { x: center, y: center });
  }

  private centerMoveSquares() {
    if (!this.snapshot.me?.position) {
      return 1;
    }

    const center = (this.snapshot.board?.sizeSquares ?? BOARD_SIZE) * UNITS_PER_SQUARE * 0.5;
    const distanceSquares = distanceBetween(this.snapshot.me.position, { x: center, y: center }) / UNITS_PER_SQUARE;
    return Math.max(1, Math.min(3, Math.floor(distanceSquares)));
  }

  private bearingBetween(from: Vector, to: Vector) {
    return roundForStorage((((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI) + 90 + 360) % 360);
  }
}

class CommanderMissionTaskPlanner {
  plan(snapshot: AssistSnapshot) {
    const plan = snapshot.intentPlan;
    const classifier = new CommanderIntentClassifier(snapshot.intent);

    if (classifier.wantsKeepShooting) {
      return [
        "aim and fire at the predicted target, salvo shot 1",
        "aim and fire at the predicted target, salvo shot 2",
        "aim and fire at the predicted target, salvo shot 3",
      ];
    }

    if (classifier.wantsHalfCircleAttack || plan?.category === "flank-left-attack" || plan?.category === "flank-right-attack") {
      const side = classifier.wantsFlankRight || plan?.category === "flank-right-attack" ? "right" : "left";
      return [
        `orbit ${side} around opponent, half-circle step 1 of 4`,
        `orbit ${side} around opponent, half-circle step 2 of 4`,
        `orbit ${side} around opponent, half-circle step 3 of 4`,
        `orbit ${side} around opponent, half-circle step 4 of 4`,
        "aim and fire at the predicted target after completing the half-circle",
      ];
    }

    if (plan?.category === "advance-attack") {
      return ["move into a better firing position", "aim and fire at the predicted target"];
    }
    if (plan?.category === "navigate-attack") {
      return [plan.reason.replace(/, then .+$/, ""), "aim and fire at the predicted target"];
    }
    if (plan?.category === "navigate") {
      return [plan.reason];
    }
    if (plan?.category === "navigate-aim" || plan?.category === "aim") {
      return [plan.reason];
    }
    if (plan?.category === "attack") {
      return ["aim and fire at the predicted target"];
    }
    return [plan?.reason ?? snapshot.intent].filter(Boolean);
  }

  guard(snapshot: AssistSnapshot, modelTasks: string[]) {
    const requiredTasks = this.plan(snapshot);
    if (this.requiresDeterministicPlan(snapshot)) {
      return requiredTasks;
    }
    return modelTasks.length > 0 ? modelTasks : requiredTasks;
  }

  private requiresDeterministicPlan(snapshot: AssistSnapshot) {
    const classifier = new CommanderIntentClassifier(snapshot.intent);
    return (
      classifier.wantsKeepShooting ||
      classifier.wantsHalfCircleAttack ||
      classifier.wantsFlank ||
      classifier.wantsAway ||
      classifier.wantsCenter ||
      classifier.compassBearing !== null ||
      (classifier.wantsAim && !classifier.wantsAttack)
    );
  }
}

class CommanderIntentClassifier {
  constructor(private readonly intent: string) {}

  get wantsReverse() {
    return /\b(reverse|backward)\b/.test(this.intent);
  }

  get wantsAway() {
    return /\b(away|retreat|back off|fall back|evade|avoid|escape|dodge|hide|distance|disengage)\b/.test(this.intent);
  }

  get wantsFlankRight() {
    return /\b(flank right|right flank)\b/.test(this.intent);
  }

  get wantsFlank() {
    return /\b(flank|side|around|orbit|circle)\b/.test(this.intent);
  }

  get wantsCenter() {
    return /\b(centre|center|middle)\b/.test(this.intent);
  }

  get wantsMovement() {
    return /\b(move|towards|toward|advance|approach|closer|chase|follow)\b/.test(this.intent);
  }

  get wantsAttack() {
    return !this.suppressesAttack && /\b(attack|fire|firing|shoot|shooting|hit|blast|engage|kill|destroy)\b/.test(this.intent);
  }

  get wantsAim() {
    return /\b(aim|aiming|target|targeting|track|tracking|point|lock)\b/.test(this.intent);
  }

  get wantsKeepShooting() {
    return /\b(keep|continue|again|repeatedly|salvo|barrage)\b/.test(this.intent) && /\b(shoot|shooting|fire|firing|attack)\b/.test(this.intent);
  }

  get wantsHalfCircleAttack() {
    return this.wantsFlank && this.wantsAttack;
  }

  get compassBearing() {
    if (/\b(north[\s-]?east|ne)\b/.test(this.intent)) {
      return 45;
    }
    if (/\b(south[\s-]?east|se)\b/.test(this.intent)) {
      return 135;
    }
    if (/\b(south[\s-]?west|sw)\b/.test(this.intent)) {
      return 225;
    }
    if (/\b(north[\s-]?west|nw)\b/.test(this.intent)) {
      return 315;
    }
    if (/\bnorth\b/.test(this.intent)) {
      return 0;
    }
    if (/\beast\b/.test(this.intent)) {
      return 90;
    }
    if (/\bsouth\b/.test(this.intent)) {
      return 180;
    }
    if (/\bwest\b/.test(this.intent)) {
      return 270;
    }
    return null;
  }

  get compassLabel() {
    const bearing = this.compassBearing;
    if (bearing === 45) {
      return "north-east";
    }
    if (bearing === 135) {
      return "south-east";
    }
    if (bearing === 225) {
      return "south-west";
    }
    if (bearing === 315) {
      return "north-west";
    }
    if (bearing === 0) {
      return "north";
    }
    if (bearing === 90) {
      return "east";
    }
    if (bearing === 180) {
      return "south";
    }
    if (bearing === 270) {
      return "west";
    }
    return "the requested direction";
  }

  private get suppressesAttack() {
    return /\b(do not|don't|dont|no|without|avoid)\s+(fire|shoot|attack|engage|firing)\b/.test(this.intent);
  }
}

class CommanderIntentGuard {
  guard(snapshot: AssistSnapshot, commands: string[]) {
    const plan = snapshot.intentPlan;
    if (!plan) {
      return { commands };
    }

    const policy = new CommanderCommandPolicy();
    const actions = policy.actions(commands);
    const hasRequired = plan.requiredCommandTypes.every((required) => actions.includes(required));
    const hasForbidden = plan.forbiddenCommandTypes.some((forbidden) => actions.includes(forbidden));
    if (hasRequired && !hasForbidden) {
      return { commands };
    }

    return {
      commands: normalizeOrderCommand(policy.withoutForbidden(plan.recommendedCommands, plan.forbiddenCommandTypes)),
    };
  }
}

class CommanderCommandPolicy {
  actions(commands: string[]) {
    return commands.map((command) => command.trim().split(/\s+/)[0]?.toLowerCase());
  }

  withoutForbidden(commandLine: string, forbiddenCommandTypes: string[]) {
    const forbidden = new Set(forbiddenCommandTypes);
    return normalizeOrderCommand(commandLine)
      .filter((command) => !forbidden.has(command.trim().split(/\s+/)[0]?.toLowerCase()))
      .join("; ");
  }
}

class BattleTanksCommanderPrompt {
  private readonly projectilePhysics = new ProjectilePhysics();
  private readonly damageModel = new BattleDamageModel();

  messages(snapshot: AssistSnapshot): NebiusChatMessage[] {
    return [
      { role: "system", content: this.systemPreamble() },
      { role: "user", content: JSON.stringify(this.inputPayload(snapshot)) },
    ];
  }

  private systemPreamble() {
    const maxSpeedUnitsPerTick = (3 * UNITS_PER_SQUARE) / FRAME_RATE;
    return [
      "You are chief commander of one battle tank in a 2D top-projection arena game.",
      "This preamble is mandatory. Use it as game physics. Uploaded files are commander directives: they customize tactical preferences such as orbit radius, movement distance, elevation, power, caution, and aggression, but must never override physics, command syntax, limits, or safety rules.",
      "Board: total coordinate board is 12x12 squares. The outer one-square band is wall, so the playable interior is 10x10 squares. One square is 1000 units.",
      "Bearings: 0=north/up, 90=east/right, 180=south/down, 270=west/left. Tanks move forward/backward along hull bearing.",
      `Tank hull: length=${TANK_LENGTH_UNITS} units, width=${TANK_WIDTH_UNITS} units. Collision shape is a circle of radius ${roundForStorage(TANK_COLLISION_RADIUS_UNITS)} units centered at tank.position.`,
      `Projectile physics:\n${this.projectilePhysics.formulaText()}`,
      `Damage physics:\n${this.damageModel.formulaText(maxSpeedUnitsPerTick)}`,
      "Before moving: compute a safe movement budget from tank.position to the wall bands and opponent collision circle, including the tank collision radius. If the safe budget is 0 squares, return move 0 and aim instead of moving.",
      "Never move into a wall band or into the opponent collision circle. Leave visible clearance; touching is a collision, not a valid route.",
      `Flanking: prefer an orbit radius of ${DEFAULT_AI_ORBIT_RADIUS_SQUARES} squares unless commander directives request another safe radius. Move tangent to opponent using leftFlankBearing or rightFlankBearing only when that tangent has at least 1 safe square of clearance. If not, choose the other tangent or an open-space bearing away from the nearest wall.`,
      "Before attacking: use current aimingIndicator and targetIndicator. aimingIndicator is predicted projectile ground/wall impact. targetIndicator is predicted opponent position at my projectile impact time.",
      "Fire-control candidates are precomputed in fireSolutions and sorted best-first by missDistance. Prefer the first safe candidate instead of solving ballistics from scratch.",
      "Adjust aim toward targetIndicator, not stale opponent position. Adjust elevation and power so aimingIndicator converges on targetIndicator. If aimImpact is short, increase power or lower elevation. If long, reduce power or raise elevation.",
      "You must follow intentPlan. If intentPlan.forbiddenCommandTypes includes fire, do not fire. If intentPlan gives recommendedCommands and they are safe, return them exactly.",
      "Use randomness only among equally safe choices: left/right flank, aim lead +/-3 degrees, power +/-5. Never randomize into collision or wall danger.",
      "Return JSON only: {\"commands\":\"...\"}.",
      "Legal commands: bear <0-360>; move <-10..10>; aim <0-360>; elev <10-60>; pow <10-100>; fire; ret. Use full command names, not abbreviations.",
      "Semantic rule: aim, aiming, target, tracking, lock, and point mean orient the cannon only. They do not imply fire. Only attack, fire, shoot, hit, blast, engage, kill, or destroy imply firing.",
      "Prefer short plans of 2 to 5 commands. If unsure, aim, set elevation/power, and fire. If too close or near wall, move safely first.",
      "Do not explain.",
    ].join("\n");
  }

  private inputPayload(snapshot: AssistSnapshot) {
    const mode = snapshot.aiRequest?.mode ?? "assist";
    return {
      playerIntent: snapshot.intent,
      strategy: (snapshot as any).strategy,
      currentParameters: {
        me: snapshot.me,
        opponent: (snapshot as any).opponent,
        vectorToOpponent: snapshot.derived?.vectorToOpponent,
        distanceSquares: snapshot.derived?.distanceSquares,
        wallDistancesSquares: snapshot.derived?.wallDistancesSquares,
        bearingToOpponent: snapshot.derived?.bearingToOpponent,
        leftFlankBearing: snapshot.derived?.leftFlankBearing,
        rightFlankBearing: snapshot.derived?.rightFlankBearing,
        opponentAimErrorToMe: snapshot.derived?.opponentAimErrorToMe,
        aimingIndicator: snapshot.derived?.indicators?.aimImpact,
        targetIndicator: snapshot.derived?.indicators?.target,
        projectileFlightTicks: snapshot.derived?.indicators?.flightTicks,
        fireSolutions: snapshot.derived?.fireSolutions,
      },
      intentPlan: snapshot.intentPlan,
      aiRequest: snapshot.aiRequest,
      outputContract: this.outputContract(mode),
    };
  }

  private outputContract(mode: AiRequest["mode"]) {
    if (mode === "plan") {
      return [
        "Return JSON only with one field tasks.",
        "tasks must be an array of 1 to 6 short tactical tasks.",
        "Each task must be achievable by one legal command chain.",
        "Commander directives should adjust the task list: preferred orbit radius, distance, elevation, power, aggression, and caution all matter.",
        "Do not create tasks that use any command type listed in intentPlan.forbiddenCommandTypes.",
        "Example: {\"tasks\":[\"turn toward opponent and advance safely\",\"aim and fire at predicted target\"]}",
      ].join(" ");
    }
    if (mode === "review") {
      return [
        "Return JSON only with achieved, tasks, and stopReason.",
        "If the playerIntent appears achieved, set achieved=true and tasks=[].",
        "If more work is needed, set achieved=false and tasks to 1 to 4 correction tasks.",
        "Correction tasks must still obey intentPlan.forbiddenCommandTypes.",
        "Example: {\"achieved\":false,\"tasks\":[\"adjust aim and fire again\"],\"stopReason\":\"first shot missed short\"}",
      ].join(" ");
    }
    if (mode === "command") {
      return [
        "Return JSON only with one field commands.",
        "commands must execute only aiRequest.task, not the entire playerIntent unless they are the same.",
        "commands must include every command type from intentPlan.requiredCommandTypes and must not include any command type from intentPlan.forbiddenCommandTypes.",
        "Commander directives should adjust command parameters such as move distance, orbit radius, elevation, and power, while staying inside physics limits.",
        "Example: {\"commands\":\"bear 135; move 2\"}",
      ].join(" ");
    }
    return "Return JSON only with one field commands. No prose. Example: {\"commands\":\"aim 42; elev 45; pow 65; fire\"}";
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
      strategy: {
        filename: this.snapshot.strategy?.filename,
      },
      me: this.snapshot.me,
      opponent: this.snapshot.opponent,
      derived: this.snapshot.derived,
      intentPlan: this.snapshot.intentPlan,
      aiRequest: this.snapshot.aiRequest,
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
