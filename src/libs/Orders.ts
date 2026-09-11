export type Command =
  | `bear ${number}`
  | `move ${number}`
  | `aim ${number}`
  | `elev ${number}`
  | `pow ${number}`
  | "fire"
  | "ret";

export class Orders {
  constructor(readonly commands: Command[], readonly invalidCommands: string[] = []) {}

  get isEmpty() {
    return this.commands.length === 0;
  }

  get hasInvalidCommands() {
    return this.invalidCommands.length > 0;
  }

  static parse(script: string) {
    const commands: Command[] = [];
    const invalidCommands: string[] = [];

    for (const command of script.split(/[\n,;]+/)) {
      const normalized = command.trim();
      if (!normalized) {
        continue;
      }

      const parsed = normalizeCommand(normalized);
      if (!parsed) {
        invalidCommands.push(normalized);
        continue;
      }

      commands.push(...parsed);
    }

    return new Orders(commands, invalidCommands);
  }
}

function normalizeCommand(command: string): Command[] | null {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  const [rawAction, rawAmount, rawSecondAmount, extra] = normalized.split(" ");
  const action = expandCommandAction(rawAction);
  if (extra !== undefined) {
    return null;
  }

  if (action === "bear") {
    const bearing = strictHeading(rawAmount);
    if (rawSecondAmount !== undefined) {
      return null;
    }

    return bearing === null ? null : [`bear ${roundForStorage(bearing)}`];
  }

  if (action === "move") {
    const units = strictNumber(rawAmount, -10, 10);
    if (units === null || rawSecondAmount !== undefined) {
      return null;
    }

    return [`move ${roundForStorage(units)}`];
  }

  if (action === "aim") {
    const bearing = strictHeading(rawAmount);
    if (bearing === null || rawSecondAmount !== undefined) {
      return null;
    }

    return [`aim ${roundForStorage(bearing)}`];
  }

  if (action === "elev") {
    const elevation = strictNumber(rawAmount, 10, 60);
    if (elevation === null || rawSecondAmount !== undefined) {
      return null;
    }

    return [`elev ${roundForStorage(elevation)}`];
  }

  if (action === "pow") {
    const power = strictNumber(rawAmount, 10, 100);
    if (power === null || rawSecondAmount !== undefined) {
      return null;
    }

    return [`pow ${roundForStorage(power)}`];
  }

  if (action === "fire") {
    if (rawAmount !== undefined || rawSecondAmount !== undefined) {
      return null;
    }

    return ["fire"];
  }

  if (action === "ret") {
    if (rawAmount !== undefined || rawSecondAmount !== undefined) {
      return null;
    }

    return [action];
  }

  return null;
}

function expandCommandAction(action: string | undefined) {
  if (action === "b") {
    return "bear";
  }
  if (action === "m") {
    return "move";
  }
  if (action === "a") {
    return "aim";
  }
  if (action === "e") {
    return "elev";
  }
  if (action === "p") {
    return "pow";
  }
  if (action === "f") {
    return "fire";
  }
  if (action === "r") {
    return "ret";
  }
  return action;
}

function strictNumber(rawAmount: string | undefined, min: number, max: number) {
  if (rawAmount === undefined) {
    return null;
  }

  const amount = Number(rawAmount);
  if (!Number.isFinite(amount)) {
    return null;
  }

  if (amount < min || amount > max) {
    return null;
  }

  return amount;
}

function strictHeading(rawAmount: string | undefined) {
  const heading = strictNumber(rawAmount, 0, 36);
  return heading === null ? null : normalizeDegrees(heading * 10);
}

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function roundForStorage(value: number) {
  return Math.round(value * 10000) / 10000;
}
