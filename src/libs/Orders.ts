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
  constructor(readonly commands: Command[]) {}

  get isEmpty() {
    return this.commands.length === 0;
  }

  static parse(script: string) {
    const commands = script
      .split(/[\n,]+/)
      .flatMap(normalizeCommand);

    return new Orders(commands);
  }
}

function normalizeCommand(command: string): Command[] {
  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  const [action, rawAmount, rawSecondAmount] = normalized.split(" ");

  if (action === "wait") {
    return ["wait"];
  }

  if (action === "lock" || action === "unlock") {
    return [action];
  }

  if (action === "forward" || action === "backward") {
    return repeatCommand(`${action} 1`, boundedAmount(rawAmount, 10, 0, 120));
  }

  if (action === "fire") {
    if (rawSecondAmount === undefined) {
      return [`fire 100 ${roundForStorage(boundedNumber(rawAmount, 45, 30, 60))}`];
    }

    return [
      `fire ${roundForStorage(boundedNumber(rawAmount, 100, 10, 100))} ${roundForStorage(boundedNumber(rawSecondAmount, 45, 30, 60))}`,
    ];
  }

  if (action === "left" || action === "right") {
    const sign = action === "right" ? 1 : -1;
    return expandRotationCommand("hull-step", sign * boundedNumber(rawAmount, 90, 0, 360));
  }

  if (action === "turret") {
    return expandRotationCommand("turret-step", boundedNumber(rawAmount, 0, -360, 360));
  }

  return [];
}

function boundedAmount(rawAmount: string | undefined, fallback: number, min: number, max: number) {
  return Math.round(boundedNumber(rawAmount, fallback, min, max));
}

function boundedNumber(rawAmount: string | undefined, fallback: number, min: number, max: number) {
  const amount = rawAmount === undefined ? fallback : Number(rawAmount);
  if (!Number.isFinite(amount)) {
    return fallback;
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
