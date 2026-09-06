export type Command =
  | `bear ${number}`
  | `move ${number}`
  | `aim ${number} ${number}`
  | `fire ${number}`;

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
  const [action, rawAmount, rawSecondAmount, extra] = normalized.split(" ");
  if (extra !== undefined) {
    return null;
  }

  if (action === "bear") {
    const bearing = strictNumber(rawAmount, 0, 360);
    if (rawSecondAmount !== undefined) {
      return null;
    }

    return bearing === null ? null : [`bear ${roundForStorage(normalizeDegrees(bearing))}`];
  }

  if (action === "move") {
    const squares = strictNumber(rawAmount, 0.1, 20);
    if (squares === null || rawSecondAmount !== undefined) {
      return null;
    }

    return [`move ${roundForStorage(squares)}`];
  }

  if (action === "aim") {
    const bearing = strictNumber(rawAmount, 0, 360);
    const elevation = strictNumber(rawSecondAmount, 10, 60);
    if (bearing === null || elevation === null) {
      return null;
    }

    return [`aim ${roundForStorage(normalizeDegrees(bearing))} ${roundForStorage(elevation)}`];
  }

  if (action === "fire") {
    const power = strictNumber(rawAmount, 10, 100);
    if (power === null || rawSecondAmount !== undefined) {
      return null;
    }

    return [`fire ${roundForStorage(power)}`];
  }

  return null;
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

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function roundForStorage(value: number) {
  return Math.round(value * 10000) / 10000;
}
