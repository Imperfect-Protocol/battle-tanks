import type { Id } from "../../convex/_generated/dataModel";
import { DEFAULT_FIRE_ANGLE_DEGREES, DEFAULT_FIRE_POWER, UNITS_PER_SQUARE, angleFromDirection } from "../../convex/gameCore";
import type { Tank } from "./Tank";

export type IntentFileSummary = {
  id: Id<"intentFiles">;
  filename: string;
  size: number;
  createdAt: number;
  updatedAt: number;
};

export type AiAssistResult = {
  commandLine: string;
  commands: string[];
  tasks?: string[];
  achieved?: boolean;
  stopReason?: string;
  provider: string;
  model: string;
  configured: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  debugInput?: unknown;
  debugPrompt?: unknown;
  debugReply?: unknown;
};

export type AiAssistMode = "assist" | "plan" | "command" | "review";

export type AiAssistRequest = {
  roomCode: string;
  commanderId: Id<"commanderProfiles">;
  intentFileId: Id<"intentFiles">;
  intent: string;
  model?: string;
  mode?: AiAssistMode;
  task?: string;
  tasks?: string[];
  completedTask?: string;
  completedCommands?: string[];
};

export type AiMissionCallbacks = {
  assist: (request: AiAssistRequest) => Promise<AiAssistResult>;
  execute: (commandLine: string) => Promise<void>;
  waitForIdle: () => Promise<void>;
  log: (result: AiAssistResult) => void;
  announce: (message: string) => void;
};

export type AiConsoleMetaCommand =
  | {
      action: "useModel";
      model: string;
    };

const AI_MISSION_BUDGET_USD = 0.1;
const AI_MISSION_MAX_STEPS = 5;

export class AiCommandConsolePresenter {
  formatPrompt(tank: Tank | null) {
    if (!tank) {
      return "-- -- --, -- -- --";
    }

    const x = this.formatSquareCoordinate(tank.record.position.x);
    const y = this.formatSquareCoordinate(tank.record.position.y);
    const bearing = this.formatHeading(angleFromDirection(tank.record.hullDirection));
    const aim = this.formatHeading(angleFromDirection(tank.record.turretDirection));
    const elevation = this.formatInteger(tank.record.launchAngle ?? DEFAULT_FIRE_ANGLE_DEGREES);
    const power = this.formatInteger(tank.record.cannonPower ?? tank.record.lastFirePower ?? DEFAULT_FIRE_POWER);

    return `${x} ${y} ${bearing}, ${aim} ${elevation} ${power}`;
  }

  formatMetrics(result: AiAssistResult) {
    const parts = [
      result.configured ? "Nebius" : "Nebius not configured: local preview",
      `${result.latencyMs}ms`,
    ];
    if (result.estimatedCostUsd !== undefined) {
      parts.push(`$${result.estimatedCostUsd.toFixed(6)}`);
    }
    if (result.inputTokens !== undefined || result.outputTokens !== undefined) {
      parts.push(`tokens ${this.formatTokenUsage(result)}`);
    }
    return parts.join(" · ");
  }

  formatCommandTokens(result: AiAssistResult) {
    return `Command tokens: ${this.formatTokenUsage(result)}`;
  }

  formatMissionTokens(inputTokens: number, outputTokens: number, spentUsd: number) {
    const parts = [`AI mission tokens: ${inputTokens} in / ${outputTokens} out / ${inputTokens + outputTokens} total`];
    if (spentUsd > 0) {
      parts.push(`$${spentUsd.toFixed(6)}`);
    }
    return parts.join(" · ");
  }

  formatBytes(size: number) {
    if (size < 1024) {
      return `${size} B`;
    }
    return `${Math.round(size / 102.4) / 10} KB`;
  }

  private formatSquareCoordinate(value: number) {
    return this.formatInteger(value / UNITS_PER_SQUARE);
  }

  private formatHeading(value: number) {
    return String(Math.round((((value % 360) + 360) % 360) / 10)).padStart(2, "0");
  }

  private formatInteger(value: number) {
    return String(Math.round(value));
  }

  private formatTokenUsage(result: Pick<AiAssistResult, "inputTokens" | "outputTokens">) {
    const inputTokens = result.inputTokens ?? 0;
    const outputTokens = result.outputTokens ?? 0;
    return `${inputTokens} in / ${outputTokens} out / ${inputTokens + outputTokens} total`;
  }
}

export class AiCommanderMission {
  private spentUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private readonly presenter = new AiCommandConsolePresenter();
  private readonly completedCommands: string[] = [];
  private readonly completedTasks: string[] = [];

  constructor(
    private readonly request: Omit<AiAssistRequest, "mode" | "task" | "tasks" | "completedTask" | "completedCommands">,
    private readonly callbacks: AiMissionCallbacks,
  ) {}

  async run() {
    const planned = await this.callModel({ mode: "plan" });
    let tasks = this.readTasks(planned);
    this.callbacks.announce(`AI tasks: ${tasks.join("; ")}`);

    for (let step = 0; step < AI_MISSION_MAX_STEPS && tasks.length > 0; step += 1) {
      const task = tasks[0];
      const command = await this.callModel({ mode: "command", task, tasks });
      if (command.commandLine) {
        this.callbacks.announce(`AI: ${command.commandLine}`);
        this.callbacks.announce(this.presenter.formatCommandTokens(command));
        await this.callbacks.execute(command.commandLine);
        this.completedCommands.push(command.commandLine);
        this.completedTasks.push(task);
        await this.callbacks.waitForIdle();
      }

      const review = await this.callModel({
        mode: "review",
        task,
        tasks,
        completedTask: task,
        completedCommands: this.completedCommands,
      });
      if (review.achieved && tasks.length <= 1) {
        this.callbacks.announce(review.stopReason ? `AI complete: ${review.stopReason}` : "AI complete");
        this.announceMissionTokens();
        return;
      }

      const correctionTasks = this.newCorrectionTasks(review);
      tasks = review.achieved ? tasks.slice(1) : correctionTasks.length > 0 ? correctionTasks : tasks.slice(1);
      if (this.isBudgetExceeded()) {
        this.callbacks.announce(`AI stopped: $${AI_MISSION_BUDGET_USD.toFixed(2)} budget reached`);
        this.announceMissionTokens();
        return;
      }
      if (tasks.length === 0) {
        this.callbacks.announce(review.stopReason ? `AI stopped: ${review.stopReason}` : "AI stopped: no correction tasks");
        this.announceMissionTokens();
        return;
      }
    }

    this.callbacks.announce("AI stopped: task limit reached");
    this.announceMissionTokens();
  }

  private async callModel(extra: Partial<AiAssistRequest>) {
    if (this.isBudgetExceeded()) {
      throw new Error(`AI budget exceeded $${AI_MISSION_BUDGET_USD.toFixed(2)}`);
    }

    const result = await this.callbacks.assist({ ...this.request, ...extra });
    this.spentUsd += result.estimatedCostUsd ?? 0;
    this.inputTokens += result.inputTokens ?? 0;
    this.outputTokens += result.outputTokens ?? 0;
    this.callbacks.log(result);
    return result;
  }

  private readTasks(result: AiAssistResult) {
    return (result.tasks ?? []).map((task) => task.trim()).filter(Boolean);
  }

  private newCorrectionTasks(result: AiAssistResult) {
    const completed = new Set(this.completedTasks.map((task) => task.toLowerCase()));
    return this.readTasks(result).filter((task) => !completed.has(task.toLowerCase()));
  }

  private isBudgetExceeded() {
    return this.spentUsd >= AI_MISSION_BUDGET_USD;
  }

  private announceMissionTokens() {
    this.callbacks.announce(this.presenter.formatMissionTokens(this.inputTokens, this.outputTokens, this.spentUsd));
  }
}

export class AiConsoleMetaCommandParser {
  parse(command: string): AiConsoleMetaCommand | null {
    const trimmed = command.trim();
    if (!trimmed.startsWith("/")) {
      return null;
    }

    const usePrefix = "/use ";
    if (trimmed.toLowerCase().startsWith(usePrefix)) {
      const model = trimmed.slice(usePrefix.length).trim();
      if (!model || /\s/.test(model)) {
        throw new Error("Usage: /use <model>");
      }
      return { action: "useModel", model };
    }

    throw new Error("Incorrect command");
  }
}
