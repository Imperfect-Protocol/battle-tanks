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
  provider: string;
  model: string;
  configured: boolean;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  debugInput?: unknown;
};

export type AiConsoleMetaCommand =
  | {
      action: "useModel";
      model: string;
    };

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
      parts.push(`${result.inputTokens ?? 0} in / ${result.outputTokens ?? 0} out`);
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
