export type Command =
  | `run ${number}`
  | `turn ${number}`
  | `aim ${number} ${number}`
  | `hull-step ${number}`
  | `turret-step ${number}`
  | `aim-angle ${number}`
  | `fire ${number}`
  | "stop"
  | "lock"
  | "unlock"
  | "wait";

const rotationDegreesPerTick = 360 / (3 * 25);

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

  if (action === "wait") {
    return rawAmount === undefined ? ["wait"] : null;
  }

  if (action === "stop") {
    return rawAmount === undefined ? ["stop"] : null;
  }

  if (action === "lock" || action === "unlock") {
    return rawAmount === undefined ? [action] : null;
  }

  if (action === "run") {
    const speed = boundedNumber(rawAmount, 0, 30);
    return speed === null ? null : [`run ${roundForStorage(speed)}`];
  }

  if (action === "fire") {
    if (rawSecondAmount !== undefined) {
      return null;
    }
    const power = boundedNumber(rawAmount, 10, 100);
    if (power === null) {
      return null;
    }

    return [`fire ${roundForStorage(power)}`];
  }

  if (action === "turn") {
    const amount = boundedNumber(rawAmount, -360, 360);
    if (amount === null) {
      return null;
    }

    return expandRotationCommand("hull-step", amount);
  }

  if (action === "aim") {
    const horizontal = boundedNumber(rawAmount, -360, 360);
    const vertical = boundedNumber(rawSecondAmount, 30, 60);
    if (horizontal === null || vertical === null) {
      return null;
    }

    return [
      ...expandRotationCommand("turret-step", horizontal),
      `aim-angle ${roundForStorage(vertical)}` as Command,
    ];
  }

  return null;
}

function boundedAmount(rawAmount: string | undefined, min: number, max: number) {
  const amount = boundedNumber(rawAmount, min, max);
  return amount === null ? null : Math.round(amount);
}

function boundedNumber(rawAmount: string | undefined, min: number, max: number) {
  if (rawAmount === undefined) {
    return null;
  }

  const amount = Number(rawAmount);
  if (!Number.isFinite(amount)) {
    return null;
  }

  return Math.max(min, Math.min(max, amount));
}

function repeatCommand(command: Command, times: number) {
  return Array.from({ length: times }, () => command);
}

function expandRotationCommand(action: "hull-step" | "turret-step", degrees: number): Command[] {
  const stepCount = Math.max(1, Math.ceil(Math.abs(degrees) / rotationDegreesPerTick));
  const stepDegrees = degrees / stepCount;
  return Array.from({ length: stepCount }, () => `${action} ${roundForStorage(stepDegrees)}` as Command);
}

function roundForStorage(value: number) {
  return Math.round(value * 10000) / 10000;
}
