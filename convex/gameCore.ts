export const BOARD_SIZE = 12;
export const DEFAULT_LOBBY_ID = "pvp";
export const MAX_HEALTH = 100;
export const UNITS_PER_SQUARE = 1000;
export const TANK_LENGTH_UNITS = UNITS_PER_SQUARE * 1.18;
export const TANK_WIDTH_UNITS = UNITS_PER_SQUARE * 0.62;
export const TANK_COLLISION_RADIUS_UNITS = Math.hypot(TANK_LENGTH_UNITS / 2, TANK_WIDTH_UNITS / 2);
export const FRAME_RATE = 25;
export const DEFAULT_FIRE_ANGLE_DEGREES = 45;
export const DEFAULT_FIRE_POWER = 100;
export const MIN_FIRE_POWER = 10;
export const MAX_FIRE_POWER = 100;
export const MIN_AIM_ELEVATION_DEGREES = 10;
export const MAX_AIM_ELEVATION_DEGREES = 60;
export const MOVE_COMMAND_UNITS_PER_SQUARE = 1;
export const MAX_MOVE_COMMAND_UNITS = 10;
export const MAX_MOVE_DISTANCE_UNITS = (MAX_MOVE_COMMAND_UNITS / MOVE_COMMAND_UNITS_PER_SQUARE) * UNITS_PER_SQUARE;

const LEGACY_DIRECTION_DEGREES = {
  north: 0,
  east: 90,
  south: 180,
  west: 270,
} as const;

const DEFAULT_TANK_SPEC = {
  hullColor: "#24f7a7",
  turretOffset: 0.333,
  cannonLength: 0.4,
  turretSize: 0.92,
};

const TANK_COLORS = ["#24f7a7", "#40d8ff", "#ffe45c", "#ff6b9d", "#b5ff5c", "#ff9c45"];
const TURRET_OFFSETS = [0.28, 0.333, 0.4, 0.48, 0.58];
const CANNON_LENGTHS = [0.32, 0.38, 0.44, 0.5, 0.56];
const TURRET_SIZES = [0.76, 0.84, 0.92, 1, 1.06];

export type StoredCommand =
  | { action: "bear"; bearing: number }
  | { action: "move"; units: number }
  | { action: "aim"; bearing: number }
  | { action: "elev"; elevation: number }
  | { action: "pow"; power: number }
  | { action: "fire" }
  | { action: "ret" };

export type OrderQueueType = "move" | "bearing" | "cannon";

export const ORDER_QUEUE_TYPES: OrderQueueType[] = ["move", "bearing", "cannon"];

export const commandHelp =
  "Commands: bear/b <00-36>, move/m <-10..10> in squares, aim/a <00-36> to hold absolute turret aim, elev/e <10-60>, pow/p <10-100>, fire/f, ret/r to return turret to hull bearing.";

export function normalizeOrderCommand(command: string): string[] {
  if (/[;,\n]/.test(command)) {
    return command.split(/[;,\n]+/).flatMap(normalizeOrderCommand);
  }

  const normalized = command.trim().toLowerCase().replace(/\s+/g, " ");
  const parsed = parseInputCommand(normalized);
  if (!parsed) {
    return [];
  }
  return [serializeCommand(parsed)];
}

export function parseStoredCommand(command: string): StoredCommand | null {
  const [rawAction, rawAmount, rawSecondAmount, extra] = command.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
  const action = expandCommandAction(rawAction);
  if (extra !== undefined) {
    return null;
  }

  if (action === "bear") {
    const bearing = strictNumber(rawAmount, 0, 360);
    if (bearing === null || rawSecondAmount !== undefined) {
      return null;
    }

    return { action, bearing: roundForStorage(normalizeDegrees(bearing)) };
  }

  if (action === "move") {
    const units = strictNumber(rawAmount, -MAX_MOVE_COMMAND_UNITS, MAX_MOVE_COMMAND_UNITS);
    if (units === null || rawSecondAmount !== undefined) {
      return null;
    }

    return { action, units: roundForStorage(units) };
  }

  if (action === "aim") {
    const bearing = strictNumber(rawAmount, 0, 360);
    if (bearing === null || rawSecondAmount !== undefined) {
      return null;
    }

    return { action, bearing: roundForStorage(normalizeDegrees(bearing)) };
  }

  if (action === "elev") {
    const elevation = strictNumber(rawAmount, MIN_AIM_ELEVATION_DEGREES, MAX_AIM_ELEVATION_DEGREES);
    if (elevation === null || rawSecondAmount !== undefined) {
      return null;
    }

    return { action, elevation: roundForStorage(elevation) };
  }

  if (action === "pow") {
    const power = strictNumber(rawAmount, MIN_FIRE_POWER, MAX_FIRE_POWER);
    if (power === null || rawSecondAmount !== undefined) {
      return null;
    }

    return { action, power: roundForStorage(power) };
  }

  if (action === "fire") {
    if (rawAmount !== undefined || rawSecondAmount !== undefined) {
      return null;
    }

    return { action };
  }

  if (action === "ret") {
    if (rawAmount !== undefined || rawSecondAmount !== undefined) {
      return null;
    }

    return { action };
  }

  return null;
}

export function serializeCommand(command: StoredCommand) {
  if (command.action === "bear") {
    return `bear ${roundForStorage(command.bearing)}`;
  }
  if (command.action === "move") {
    return `move ${roundForStorage(command.units)}`;
  }
  if (command.action === "aim") {
    return `aim ${roundForStorage(command.bearing)}`;
  }
  if (command.action === "elev") {
    return `elev ${roundForStorage(command.elevation)}`;
  }
  if (command.action === "pow") {
    return `pow ${roundForStorage(command.power)}`;
  }
  if (command.action === "ret") {
    return command.action;
  }
  return "fire";
}

export function emptyCommandQueues() {
  return {
    move: [],
    bearing: [],
    cannon: [],
  } as Record<OrderQueueType, string[]>;
}

export function compressCommandQueues(commandsByQueue: Record<OrderQueueType, string[]>) {
  return {
    move: commandsByQueue.move,
    bearing: compressBearingCommands(commandsByQueue.bearing),
    cannon: compressCannonCommands(commandsByQueue.cannon),
  } as Record<OrderQueueType, string[]>;
}

export function queueTypeForCommand(command: StoredCommand): OrderQueueType {
  if (command.action === "move") {
    return "move";
  }
  if (command.action === "bear") {
    return "bearing";
  }
  return "cannon";
}

export async function completeActiveOrdersForQueue(
  ctx: any,
  orders: any[],
  tankId: any,
  queueType: OrderQueueType,
  now: number,
) {
  for (const order of orders) {
    if (order.tankId !== tankId || order.status === "complete" || orderQueueType(order) !== queueType) {
      continue;
    }

    await ctx.db.patch(order._id, {
      cursor: order.commands.length,
      status: "complete",
      updatedAt: now,
    });
  }
}

export function orderQueueType(order: any): OrderQueueType {
  if (order.queueType === "move" || order.queueType === "bearing" || order.queueType === "cannon") {
    return order.queueType;
  }

  const command = order.commands[order.cursor] ?? order.commands[0];
  const parsed = command ? parseStoredCommand(command) : null;
  return parsed ? queueTypeForCommand(parsed) : "cannon";
}

export function normalizeRoom(roomCode: string) {
  return roomCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "Room";
}

export function normalizeLobbyId(lobbyId: string | undefined) {
  return lobbyId?.trim().toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 24) || DEFAULT_LOBBY_ID;
}

export function cleanBattleName(name: string | undefined) {
  return name?.trim().slice(0, 48) || "Battle";
}

export function spawnPoint(index: 0 | 1) {
  return index === 0 ?
    {
      x: UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS,
      y: UNITS_PER_SQUARE + TANK_COLLISION_RADIUS_UNITS,
    }
    :
    {
      x: (BOARD_SIZE - 1) * UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS,
      y: (BOARD_SIZE - 1) * UNITS_PER_SQUARE - TANK_COLLISION_RADIUS_UNITS,
    };
}

export function normalizeTankSpec(spec: any) {
  if (!spec) {
    return DEFAULT_TANK_SPEC;
  }

  return {
    hullColor: typeof spec.hullColor === "string" ? spec.hullColor : DEFAULT_TANK_SPEC.hullColor,
    turretOffset: clampFinite(spec.turretOffset, 0.24, 0.66, DEFAULT_TANK_SPEC.turretOffset),
    cannonLength: clampFinite(spec.cannonLength, 0.3, 0.56, DEFAULT_TANK_SPEC.cannonLength),
    turretSize: clampFinite(spec.turretSize, 0.74, 1.06, DEFAULT_TANK_SPEC.turretSize),
  };
}

export function tankSpecFromSeed(seed: string) {
  const hash = hashString(seed);
  return {
    hullColor: TANK_COLORS[pick(hash, 0, TANK_COLORS.length)],
    turretOffset: TURRET_OFFSETS[pick(hash, 8, TURRET_OFFSETS.length)],
    cannonLength: CANNON_LENGTHS[pick(hash, 16, CANNON_LENGTHS.length)],
    turretSize: TURRET_SIZES[pick(hash, 24, TURRET_SIZES.length)],
  };
}

export function moveCommandUnitsToDistance(units: number) {
  return (units / MOVE_COMMAND_UNITS_PER_SQUARE) * UNITS_PER_SQUARE;
}

export function distanceToMoveCommandUnits(distance: number) {
  return roundForStorage((distance / UNITS_PER_SQUARE) * MOVE_COMMAND_UNITS_PER_SQUARE);
}

export function unitsPerTickToSquaresPerSecond(unitsPerTick: number) {
  return roundForStorage((unitsPerTick / UNITS_PER_SQUARE) * FRAME_RATE);
}

export function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

export function shortestAngleDelta(from: number, to: number) {
  return ((normalizeDegrees(to) - normalizeDegrees(from) + 540) % 360) - 180;
}

export function angleFromDirection(direction: number | keyof typeof LEGACY_DIRECTION_DEGREES) {
  if (typeof direction === "number" && Number.isFinite(direction)) {
    return direction;
  }
  if (typeof direction === "string") {
    return LEGACY_DIRECTION_DEGREES[direction];
  }
  return 0;
}

export function vectorFromBearing(degrees: number, magnitude: number) {
  const radians = ((normalizeDegrees(degrees) - 90) * Math.PI) / 180;
  return {
    x: Math.cos(radians) * magnitude,
    y: Math.sin(radians) * magnitude,
  };
}

export function addVectors(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
  };
}

export function subtractVectors(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
  };
}

export function scaleVector(vector: { x: number; y: number }, scale: number) {
  return {
    x: vector.x * scale,
    y: vector.y * scale,
  };
}

export function dotProduct(a: { x: number; y: number }, b: { x: number; y: number }) {
  return a.x * b.x + a.y * b.y;
}

export function vectorLength(vector: { x: number; y: number }) {
  return Math.hypot(vector.x, vector.y);
}

export function normalizedVector(vector: { x: number; y: number }, fallback: { x: number; y: number }) {
  const length = vectorLength(vector);
  if (length <= 0.0001) {
    return fallback;
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
  };
}

export function reflectVector(velocity: { x: number; y: number }, normal: { x: number; y: number }) {
  const impact = dotProduct(velocity, normal);
  return subtractVectors(velocity, scaleVector(normal, 2 * impact));
}

export function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export async function sha256(value: string) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function strictNumber(rawAmount: string | undefined, min: number, max: number) {
  if (rawAmount === undefined) {
    return null;
  }

  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount < min || amount > max) {
    return null;
  }
  return amount;
}

export function strictHeading(rawAmount: string | undefined) {
  const heading = strictNumber(rawAmount, 0, 36);
  return heading === null ? null : normalizeDegrees(heading * 10);
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function clampFinite(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? clamp(value, min, max) : fallback;
}

export function roundForStorage(value: number) {
  return Math.round(value * 10000) / 10000;
}

function parseInputCommand(command: string): StoredCommand | null {
  const parsed = parseStoredCommand(command);
  if (!parsed) {
    return null;
  }

  if (parsed.action === "bear" || parsed.action === "aim") {
    const [rawAction, rawAmount] = command.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
    if (rawAction === "b" || rawAction === "a") {
      const bearing = strictHeading(rawAmount);
      return bearing === null ? null : { action: parsed.action, bearing: roundForStorage(bearing) };
    }
  }

  return parsed;
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

function compressBearingCommands(commands: string[]) {
  const lastCommand = commands.at(-1);
  return lastCommand ? [lastCommand] : [];
}

function compressCannonCommands(commands: string[]) {
  const compressed: string[] = [];
  const pending: Partial<Record<"aim" | "elev" | "pow" | "ret", string>> = {};

  const flushPending = () => {
    for (const action of ["aim", "ret", "elev", "pow"] as const) {
      const command = pending[action];
      if (command) {
        compressed.push(command);
        delete pending[action];
      }
    }
  };

  for (const command of commands) {
    const parsed = parseStoredCommand(command);
    if (!parsed) {
      continue;
    }

    if (parsed.action === "fire") {
      flushPending();
      compressed.push(command);
      continue;
    }

    if (parsed.action === "aim" || parsed.action === "ret") {
      delete pending.aim;
      delete pending.ret;
      pending[parsed.action] = command;
      continue;
    }

    if (parsed.action === "elev" || parsed.action === "pow") {
      pending[parsed.action] = command;
    }
  }

  flushPending();
  return compressed;
}

function pick(hash: number, shift: number, length: number) {
  return Math.abs(hash >> shift) % length;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return hash;
}
