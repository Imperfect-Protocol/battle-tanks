export type Command =
  | `forward ${number}`
  | `backward ${number}`
  | `left ${number}`
  | `right ${number}`
  | `turret ${number}`
  | `hull-step ${number}`
  | `turret-step ${number}`
  | `fire ${number} ${number}`
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

    for (const command of script.split(/[\n,]+/)) {
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

  if (action === "lock" || action === "unlock") {
    return rawAmount === undefined ? [action] : null;
  }

  if (action === "forward" || action === "backward") {
    const amount = boundedAmount(rawAmount, 0, 120);
    return amount === null ? null : repeatCommand(`${action} 1`, amount);
  }

  if (action === "fire") {
    const power = boundedNumber(rawAmount, 10, 100);
    const angle = boundedNumber(rawSecondAmount, 30, 60);
    if (power === null || angle === null) {
      return null;
    }

    return [`fire ${roundForStorage(power)} ${roundForStorage(angle)}`];
  }

  if (action === "left" || action === "right") {
    const amount = boundedNumber(rawAmount, 0, 360);
    if (amount === null) {
      return null;
    }

    const sign = action === "right" ? 1 : -1;
    return expandRotationCommand("hull-step", sign * amount);
  }

  if (action === "turret") {
    const amount = boundedNumber(rawAmount, -360, 360);
    return amount === null ? null : expandRotationCommand("turret-step", amount);
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
