import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { GameRoom } from "../libs/GameRoom";
import type { CommandTimelinePointRecord, ProjectileRecord, TankRecord } from "../libs/types";

const FRAME_MS = 40;
const EMA_WEIGHT = 0.1;
const LOCAL_PLAYBACK_DELAY_MS = 80;
const PROJECTILE_IMPACT_VISUAL_MS = 300;

type RenderedTank = {
  position: { x: number; y: number };
  velocity: { x: number; y: number };
  hullDirection: number;
  turretDirection: number;
  launchAngle?: number;
  cannonPower?: number;
};

type LocalTimelineClock = {
  localStartedAt: number;
  localEndedAt: number;
};

export function useBattleSimulation(
  room: GameRoom | null,
  roomCode: string,
  commanderId?: Id<"commanderProfiles"> | null,
) {
  const sendCommands = useMutation(api.game.sendCommands);
  const renderedTanksRef = useRef(new Map<string, RenderedTank>());
  const loggedTimelineStatesRef = useRef(new Map<string, string>());
  const timelineClocksRef = useRef(new Map<string, LocalTimelineClock>());
  const [simulatedRoom, setSimulatedRoom] = useState<GameRoom | null>(null);

  useEffect(() => {
    if (!room) {
      setSimulatedRoom(null);
      renderedTanksRef.current.clear();
      return;
    }

    let frameId = 0;
    let lastRenderedAt = 0;
    const tick = (time: number) => {
      if (time - lastRenderedAt >= FRAME_MS) {
        lastRenderedAt = time;
        const now = Date.now();
        rememberTimelineClocks(room, now, timelineClocksRef.current);
        logTimelineStates(room, now, loggedTimelineStatesRef.current, timelineClocksRef.current);
        setSimulatedRoom(playTimelines(room, now, renderedTanksRef.current, timelineClocksRef.current));
      }
      frameId = window.requestAnimationFrame(tick);
    };

    const now = Date.now();
    rememberTimelineClocks(room, now, timelineClocksRef.current);
    logTimelineStates(room, now, loggedTimelineStatesRef.current, timelineClocksRef.current);
    setSimulatedRoom(playTimelines(room, now, renderedTanksRef.current, timelineClocksRef.current));
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [room]);

  return {
    gameRoom: simulatedRoom,
    queueCommands: async (commands: string[]) => {
      if (!commanderId || commands.length === 0) {
        return;
      }
      for (const command of commands) {
        console.info("[Battle Tanks] submit command", command);
      }
      await (sendCommands as (args: unknown) => Promise<null>)({ roomCode, commanderId, commands });
    },
  };
}

function rememberTimelineClocks(room: GameRoom, now: number, clocks: Map<string, LocalTimelineClock>) {
  const localEndsByQueue = new Map<string, number>();
  const activeIds = new Set(room.commandTimelines.map((timeline) => timeline._id));

  for (const timeline of [...room.commandTimelines].sort((left, right) => left.startedAt - right.startedAt || left.createdAt - right.createdAt)) {
    if (clocks.has(timeline._id)) {
      localEndsByQueue.set(`${timeline.playerId}:${timeline.queueType}`, clocks.get(timeline._id)?.localEndedAt ?? now);
      continue;
    }

    const duration = Math.max(1, timeline.endedAt - timeline.startedAt);
    const queueKey = `${timeline.playerId}:${timeline.queueType}`;
    const localStartedAt = Math.max(now + LOCAL_PLAYBACK_DELAY_MS, localEndsByQueue.get(queueKey) ?? now + LOCAL_PLAYBACK_DELAY_MS);
    const clock = { localStartedAt, localEndedAt: localStartedAt + duration };
    clocks.set(timeline._id, clock);
    localEndsByQueue.set(queueKey, clock.localEndedAt);
  }

  for (const id of clocks.keys()) {
    if (!activeIds.has(id)) {
      clocks.delete(id);
    }
  }
}

function logTimelineStates(room: GameRoom, now: number, loggedStates: Map<string, string>, clocks: Map<string, LocalTimelineClock>) {
  for (const timeline of room.commandTimelines) {
    const clock = clocks.get(timeline._id);
    const state = !clock || now < clock.localStartedAt ? "Ready" : now <= clock.localEndedAt ? "Running" : "Complete";
    const key = `${timeline._id}:${state}`;
    if (loggedStates.has(key)) {
      continue;
    }
    loggedStates.set(key, state);
    console.info("[Battle Tanks] command", {
      id: timeline._id,
      queueType: timeline.queueType,
      command: timeline.command,
      state,
      startedAt: timeline.startedAt,
      endedAt: timeline.endedAt,
      pointCount: timeline.points.length,
      points: timeline.points,
    });
  }
}

function playTimelines(room: GameRoom, now: number, renderedTanks: Map<string, RenderedTank>, clocks: Map<string, LocalTimelineClock>) {
  const timelines = [...room.commandTimelines].sort((left, right) => left.startedAt - right.startedAt || left.createdAt - right.createdAt);
  const tanks = room.tanks.map((tank) => {
    const target = { ...tank.record, position: { ...tank.record.position }, velocity: { ...tank.record.velocity } };
    const delayedHealth = delayedHealthForTank(tank.id, room, now, clocks);
    if (delayedHealth !== undefined) {
      target.health = delayedHealth;
    }
    const tankTimelines = timelines.filter((timeline) => timeline.tankId === tank.id);

    for (const queueType of ["move", "bearing", "cannon"] as const) {
      const active = tankTimelines.find((timeline) => {
        const clock = clocks.get(timeline._id);
        return timeline.queueType === queueType && clock && now <= clock.localEndedAt;
      });
      if (!active) {
        continue;
      }
      const clock = clocks.get(active._id);
      const serverNow = clock ? active.startedAt + Math.max(0, now - clock.localStartedAt) : now;
      applyPoint(target, pointAt(active.points, serverNow));
    }

    const rendered = renderedTanks.get(tank.id);
    const nextRendered = rendered ? emaTank(rendered, target, EMA_WEIGHT) : renderStateFromTank(target);
    renderedTanks.set(tank.id, nextRendered);
    return applyRenderedTank(target, nextRendered);
  });
  const timelineProjectiles = projectileRecordsFromTimelines(room, now, clocks);

  return new GameRoom(
    room.match,
    room.board?.record ?? null,
    room.players.map((player) => player.record),
    tanks,
    [...room.projectiles.map((projectile) => projectile.record), ...timelineProjectiles],
    room.orders,
    room.events,
    room.commandBatches,
    room.commandTimelines,
    room.ownPendingWork,
  );
}

function delayedHealthForTank(tankId: string, room: GameRoom, now: number, clocks: Map<string, LocalTimelineClock>) {
  let health: number | undefined;
  for (const timeline of [...room.commandTimelines].sort((left, right) => left.startedAt - right.startedAt || left.createdAt - right.createdAt)) {
    if (timeline.queueType !== "cannon" || timeline.command !== "fire") {
      continue;
    }

    const impact = [...timeline.points].reverse().find((point) => point.targetTankId === tankId && point.targetHealthBefore !== undefined && point.targetHealthAfter !== undefined);
    const clock = clocks.get(timeline._id);
    if (!impact || !clock) {
      continue;
    }

    health = now < clock.localEndedAt + PROJECTILE_IMPACT_VISUAL_MS ? impact.targetHealthBefore : impact.targetHealthAfter;
  }
  return health;
}

function projectileRecordsFromTimelines(room: GameRoom, now: number, clocks: Map<string, LocalTimelineClock>): ProjectileRecord[] {
  const projectiles: ProjectileRecord[] = [];
  for (const timeline of room.commandTimelines) {
    if (timeline.queueType !== "cannon" || timeline.command !== "fire") {
      continue;
    }

    const clock = clocks.get(timeline._id);
    if (!clock || now < clock.localStartedAt || now > clock.localEndedAt + PROJECTILE_IMPACT_VISUAL_MS) {
      continue;
    }

    const serverNow = timeline.startedAt + Math.min(now - clock.localStartedAt, timeline.endedAt - timeline.startedAt);
    const point = pointAt(timeline.points, serverNow);
    if (!point?.projectilePosition) {
      continue;
    }

    projectiles.push({
      _id: `timeline-projectile:${timeline._id}`,
      ownerPlayerId: timeline.playerId,
      ownerTankId: timeline.tankId,
      position: point.projectilePosition,
      velocity: point.projectileVelocity ?? { x: 0, y: 0 },
      damage: 35,
      height: point.projectileHeight ?? 0,
      verticalVelocity: point.projectileVerticalVelocity ?? 0,
      status: point.projectileStatus ?? "active",
      explosionEndsAt: point.projectileStatus === "exploding" ? now + PROJECTILE_IMPACT_VISUAL_MS : undefined,
      updatedAt: now,
    });
  }
  return projectiles;
}

function pointAt(points: CommandTimelinePointRecord[], now: number) {
  if (points.length === 0) {
    return null;
  }
  if (now <= points[0].at) {
    return points[0];
  }
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const next = points[index];
    if (now > next.at) {
      continue;
    }
    const progress = (now - previous.at) / Math.max(1, next.at - previous.at);
    return interpolatePoint(previous, next, progress);
  }
  return points[points.length - 1];
}

function applyPoint(tank: TankRecord, point: CommandTimelinePointRecord | null) {
  if (!point) {
    return;
  }
  if (point.position) {
    tank.position = point.position;
  }
  if (point.velocity) {
    tank.velocity = point.velocity;
  }
  if (point.hullDirection !== undefined) {
    tank.hullDirection = point.hullDirection;
  }
  if (point.turretDirection !== undefined) {
    tank.turretDirection = point.turretDirection;
  }
  if (point.launchAngle !== undefined) {
    tank.launchAngle = point.launchAngle;
  }
  if (point.cannonPower !== undefined) {
    tank.cannonPower = point.cannonPower;
    tank.lastFirePower = point.cannonPower;
  }
}

function renderStateFromTank(tank: TankRecord): RenderedTank {
  return {
    position: tank.position,
    velocity: tank.velocity,
    hullDirection: angle(tank.hullDirection),
    turretDirection: angle(tank.turretDirection),
    launchAngle: tank.launchAngle,
    cannonPower: tank.cannonPower,
  };
}

function applyRenderedTank(tank: TankRecord, rendered: RenderedTank) {
  return {
    ...tank,
    position: rendered.position,
    velocity: rendered.velocity,
    hullDirection: normalizeDegrees(rendered.hullDirection),
    turretDirection: normalizeDegrees(rendered.turretDirection),
    launchAngle: rendered.launchAngle,
    cannonPower: rendered.cannonPower,
    lastFirePower: rendered.cannonPower ?? tank.lastFirePower,
  };
}

function emaTank(current: RenderedTank, target: TankRecord, weight: number): RenderedTank {
  const next = renderStateFromTank(target);
  return {
    position: {
      x: lerp(current.position.x, next.position.x, weight),
      y: lerp(current.position.y, next.position.y, weight),
    },
    velocity: {
      x: lerp(current.velocity.x, next.velocity.x, weight),
      y: lerp(current.velocity.y, next.velocity.y, weight),
    },
    hullDirection: interpolateAngle(current.hullDirection, next.hullDirection, weight),
    turretDirection: interpolateAngle(current.turretDirection, next.turretDirection, weight),
    launchAngle: next.launchAngle === undefined ? current.launchAngle : lerp(current.launchAngle ?? next.launchAngle, next.launchAngle, weight),
    cannonPower: next.cannonPower === undefined ? current.cannonPower : lerp(current.cannonPower ?? next.cannonPower, next.cannonPower, weight),
  };
}

function interpolatePoint(from: CommandTimelinePointRecord, to: CommandTimelinePointRecord, progress: number): CommandTimelinePointRecord {
  return {
    at: lerp(from.at, to.at, progress),
    position: from.position && to.position ? {
      x: lerp(from.position.x, to.position.x, progress),
      y: lerp(from.position.y, to.position.y, progress),
    } : to.position ?? from.position,
    velocity: from.velocity && to.velocity ? {
      x: lerp(from.velocity.x, to.velocity.x, progress),
      y: lerp(from.velocity.y, to.velocity.y, progress),
    } : to.velocity ?? from.velocity,
    height: interpolateOptional(from.height, to.height, progress),
    hullDirection: interpolateOptionalAngle(from.hullDirection, to.hullDirection, progress),
    turretDirection: interpolateOptionalAngle(from.turretDirection, to.turretDirection, progress),
    launchAngle: interpolateOptional(from.launchAngle, to.launchAngle, progress),
    cannonPower: interpolateOptional(from.cannonPower, to.cannonPower, progress),
    fire: to.fire,
    projectilePosition: from.projectilePosition && to.projectilePosition ? {
      x: lerp(from.projectilePosition.x, to.projectilePosition.x, progress),
      y: lerp(from.projectilePosition.y, to.projectilePosition.y, progress),
    } : to.projectilePosition ?? from.projectilePosition,
    projectileVelocity: from.projectileVelocity && to.projectileVelocity ? {
      x: lerp(from.projectileVelocity.x, to.projectileVelocity.x, progress),
      y: lerp(from.projectileVelocity.y, to.projectileVelocity.y, progress),
    } : to.projectileVelocity ?? from.projectileVelocity,
    projectileHeight: interpolateOptional(from.projectileHeight, to.projectileHeight, progress),
    projectileVerticalVelocity: interpolateOptional(from.projectileVerticalVelocity, to.projectileVerticalVelocity, progress),
    projectileStatus: to.projectileStatus ?? from.projectileStatus,
  };
}

function interpolateOptional(from: number | undefined, to: number | undefined, progress: number) {
  if (from === undefined || to === undefined) {
    return to ?? from;
  }
  return lerp(from, to, progress);
}

function interpolateOptionalAngle(from: number | undefined, to: number | undefined, progress: number) {
  if (from === undefined || to === undefined) {
    return to ?? from;
  }
  return interpolateAngle(from, to, progress);
}

function interpolateAngle(from: number, to: number, progress: number) {
  return from + shortestAngleDelta(from, to) * progress;
}

function shortestAngleDelta(from: number, to: number) {
  return ((to - from + 540) % 360) - 180;
}

function angle(direction: TankRecord["hullDirection"]) {
  if (typeof direction === "number") {
    return direction;
  }
  return { north: 0, east: 90, south: 180, west: 270 }[direction];
}

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function lerp(from: number, to: number, progress: number) {
  return from + (to - from) * progress;
}
