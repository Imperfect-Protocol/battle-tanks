import { useEffect, useMemo, useRef, useState } from "react";
import type { GameRoom } from "../libs/GameRoom";
import type { Missile } from "../libs/Missile";
import type { Tank } from "../libs/Tank";
import { normalizeTankSpec, tankSpecStyle } from "./TankAvatar";

const CANNON_WIDTH_PX = 4;
const PROJECTILE_CAMERA_HEIGHT_UNITS = 16000;
const MAX_PROJECTILE_SIZE_PX = 18;
const DEFAULT_BOARD_SIZE = 12;
const SERVER_TICK_MS = 40;
const PROJECTILE_GRAVITY_UNITS = 48;
const RENDER_EMA_WEIGHT = 0.1;
const DEFAULT_SEGMENT_MS = 40;

type BattleBoardProps = {
  gameRoom: GameRoom | null;
  localPlayerId?: string | null;
  interpolate?: boolean;
};

export function BattleBoard({ gameRoom, localPlayerId = null, interpolate = true }: BattleBoardProps) {
  const boardSize = gameRoom?.board?.size ?? DEFAULT_BOARD_SIZE;
  const walls = useMemo(() => uniqueWalls(gameRoom?.board?.walls ?? defaultWalls(boardSize)), [gameRoom?.board, boardSize]);
  const [frameNow, setFrameNow] = useState(Date.now());
  const visualState = useInterpolatedWorld(gameRoom, interpolate);
  const localTank = gameRoom?.tanks.find((tank) => tank.playerId === localPlayerId && tank.alive);
  const rawAimImpact = localTank ? predictProjectileImpact(localTank, boardSize, visualState, frameNow, localTank.record.cannonPower ?? localTank.record.lastFirePower ?? 50) : null;
  const rawTargetMarkers = localTank && rawAimImpact
    ? gameRoom?.tanks
      .filter((tank) => tank.playerId !== localPlayerId && tank.alive)
      .map((tank) => ({
        id: tank.id,
        color: normalizeTankSpec(localTank.record.tankSpec).hullColor,
        position: clampBoardPoint({
          x: observedTankPosition(tank, visualState, frameNow, boardSize).x + tank.velocity.x * rawAimImpact.flightTicks,
          y: observedTankPosition(tank, visualState, frameNow, boardSize).y + tank.velocity.y * rawAimImpact.flightTicks,
        }, boardSize),
      })) ?? []
    : [];
  const smoothedMarkerPositions = useInterpolatedGroundPoints([
    ...(localTank && rawAimImpact ? [{ key: `aim:${localTank.id}`, position: rawAimImpact.position }] : []),
    ...rawTargetMarkers.map((target) => ({ key: `target:${target.id}`, position: target.position })),
  ], frameNow);
  const aimImpact = rawAimImpact && localTank
    ? {
      ...rawAimImpact,
      position: smoothedMarkerPositions.get(`aim:${localTank.id}`) ?? rawAimImpact.position,
    }
    : null;
  const targetMarkers = rawTargetMarkers.map((target) => ({
    ...target,
    position: smoothedMarkerPositions.get(`target:${target.id}`) ?? target.position,
  }));
  const projectiles = useMemo(
    () =>
      gameRoom?.projectiles.filter(
        (projectile) =>
          projectile.record.status !== "exploding" ||
          projectile.record.explosionEndsAt === undefined ||
          projectile.record.explosionEndsAt > frameNow,
      ) ?? [],
    [gameRoom?.projectiles, frameNow],
  );

  useEffect(() => {
    if (!gameRoom) {
      return;
    }

    let frameId = 0;
    const tick = () => {
      setFrameNow(Date.now());
      frameId = window.requestAnimationFrame(tick);
    };
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [gameRoom]);

  return (
    <div className="arena" style={{ "--cells": boardSize } as React.CSSProperties}>
      {walls.map((wall) => (
        <div key={`${wall.x}-${wall.y}`} className="wall" style={cellStyle(wall.x, wall.y)} />
      ))}
      {aimImpact && localTank && (
        <GroundTarget
          className="aim-target"
          color={normalizeTankSpec(localTank.record.tankSpec).hullColor}
          position={aimImpact.position}
          boardSize={boardSize}
          variant="cross"
        />
      )}
      {targetMarkers.map((target) => (
        <GroundTarget
          key={target.id}
          className="target-marker"
          color={target.color}
          position={target.position}
          boardSize={boardSize}
          variant="rings"
        />
      ))}
      {gameRoom?.tanks.map((tank) => (
        <TankPiece
          key={tank.id}
          tank={tank}
          boardSize={boardSize}
          visualState={visualState}
          now={frameNow}
          name={gameRoom.players.find((player) => player.id === tank.playerId)?.name ?? "Tank"}
        />
      ))}
      {projectiles.map((projectile) => {
        const observedProjectile = observedProjectilePosition(projectile, visualState, frameNow, boardSize);
        return (
          <div
            key={projectile.record._id}
            className={projectile.record.status === "exploding" ? "projectile projectile--exploding" : "projectile"}
            style={projectileStyle(observedProjectile.x, observedProjectile.y, observedProjectile.height, boardSize)}
          />
        );
      })}
    </div>
  );
}

function GroundTarget({
  className,
  color,
  position,
  boardSize,
  variant,
}: {
  className: string;
  color: string;
  position: { x: number; y: number };
  boardSize: number;
  variant: "cross" | "rings";
}) {
  return (
    <div
      className={`ground-target ${className}`}
      style={
        {
          ...pointStyle(position.x, position.y, boardSize),
          "--target-color": color,
        } as React.CSSProperties
      }
    >
      {variant === "rings" && (
        <>
          <i className="ground-target__ring ground-target__ring--outer" />
          <i className="ground-target__dot" />
        </>
      )}
      {variant === "cross" && (
        <>
          <i className="ground-target__ring ground-target__ring--inner" />
          <i className="ground-target__line ground-target__line--horizontal" />
          <i className="ground-target__line ground-target__line--vertical" />
        </>
      )}
    </div>
  );
}

function TankPiece({
  tank,
  boardSize,
  visualState,
  now,
  name,
}: {
  tank: Tank;
  boardSize: number;
  visualState: InterpolatedWorld;
  now: number;
  name: string;
}) {
  const pose = visualState.tankPose(tank, now);
  const hullRotation = normalizeDegrees(pose.bearing);
  const turretHeading = normalizeDegrees(pose.aim);
  const turretRotation = normalizeDegrees(turretHeading - hullRotation);
  const tankSpec = normalizeTankSpec(tank.record.tankSpec);
  const isDestroyed = tank.health <= 0;
  const position = clampBoardPoint(pose, boardSize);

  return (
    <div
      className={isDestroyed ? "tank tank--destroyed" : "tank"}
      style={
        {
          ...pointStyle(position.x, position.y, boardSize),
          ...tankSpecStyle(tankSpec),
          "--hull-rotation": `${hullRotation - 90}deg`,
          "--turret-rotation": `${turretRotation}deg`,
          "--turret-label-rotation": `${90 - turretHeading}deg`,
        } as React.CSSProperties
      }
    >
      <i className="tank-light tank-light--front tank-light--front-top" />
      <i className="tank-light tank-light--front tank-light--front-bottom" />
      <i className="tank-light tank-light--rear tank-light--rear-top" />
      <i className="tank-light tank-light--rear tank-light--rear-bottom" />
      {isDestroyed ? (
        <i className="tank-fireball" />
      ) : (
        <i className="tank-turret">
          <i className="tank-barrel" />
          <span>{name.slice(0, 2).toUpperCase()}</span>
        </i>
      )}
    </div>
  );
}

function defaultWalls(boardSize: number) {
  const walls = [];
  for (let index = 0; index < boardSize; index += 1) {
    walls.push({ x: index, y: 0 });
    walls.push({ x: index, y: boardSize - 1 });
    walls.push({ x: 0, y: index });
    walls.push({ x: boardSize - 1, y: index });
  }
  return walls;
}

function uniqueWalls(walls: { x: number; y: number }[]) {
  const seen = new Set<string>();
  return walls.filter((wall) => {
    const key = `${wall.x}-${wall.y}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function cellStyle(x: number, y: number) {
  return {
    gridColumn: `${x + 1}`,
    gridRow: `${y + 1}`,
  };
}

function pointStyle(x: number, y: number, boardSize: number) {
  const boardPoints = boardSize * 1000;
  return {
    left: `${(x / boardPoints) * 100}%`,
    top: `${(y / boardPoints) * 100}%`,
  };
}

function projectileStyle(x: number, y: number, height: number, boardSize: number) {
  const projectedSize = perspectiveSizeForHeight(height);
  return {
    ...pointStyle(x, y, boardSize),
    "--projectile-size": `${projectedSize}px`,
    "--projectile-shadow": `${Math.min(16, 3 + height / 220)}px`,
  } as React.CSSProperties;
}

function predictProjectileImpact(tank: Tank, boardSize: number, visualState: InterpolatedWorld, now: number, power: number) {
  const tankSpec = normalizeTankSpec(tank.record.tankSpec);
  const pose = visualState.tankPose(tank, now);
  const launch = launchVelocity(power, tank.record.launchAngle ?? 45);
  const muzzleVelocity = vectorFromBearing(pose.aim, launch.horizontal);
  const velocity = {
    x: muzzleVelocity.x + tank.velocity.x,
    y: muzzleVelocity.y + tank.velocity.y,
  };
  const mountOffset = vectorFromBearing(
    pose.bearing,
    (tankSpec.turretOffset - 0.5) * 1180,
  );
  const barrelVector = vectorFromBearing(
    pose.aim,
    (tankSpec.turretSize * 620) / 2 + tankSpec.cannonLength * 1180,
  );
  const tankPosition = clampBoardPoint(pose, boardSize);
  const muzzle = {
    x: tankPosition.x + mountOffset.x + barrelVector.x,
    y: tankPosition.y + mountOffset.y + barrelVector.y,
  };
  return simulateProjectileImpact(muzzle, velocity, launch.vertical, boardSize);
}

function simulateProjectileImpact(
  muzzle: { x: number; y: number },
  velocity: { x: number; y: number },
  verticalVelocity: number,
  boardSize: number,
) {
  let position = clampBoardPoint(muzzle, boardSize);
  let height = 0;
  let currentVerticalVelocity = verticalVelocity;

  for (let flightTicks = 1; flightTicks <= 240; flightTicks += 1) {
    const nextPosition = {
      x: position.x + velocity.x,
      y: position.y + velocity.y,
    };
    const nextHeight = height + currentVerticalVelocity;
    const nextVerticalVelocity = currentVerticalVelocity - PROJECTILE_GRAVITY_UNITS;
    const hitsWall =
      nextPosition.x <= 1000 ||
      nextPosition.y <= 1000 ||
      nextPosition.x >= boardSize * 1000 - 1000 ||
      nextPosition.y >= boardSize * 1000 - 1000;
    const hitsGround = nextHeight <= 0 && nextVerticalVelocity < 0;

    position = clampBoardPoint(nextPosition, boardSize);
    height = Math.max(0, nextHeight);
    currentVerticalVelocity = nextVerticalVelocity;

    if (hitsWall || hitsGround) {
      return {
        flightTicks,
        position,
      };
    }
  }

  return {
    flightTicks: 240,
    position,
  };
}

function observedTankPosition(tank: Tank, visualState: InterpolatedWorld, now: number, boardSize: number) {
  const position = visualState.tankPosition(tank, now);
  return clampBoardPoint(position, boardSize);
}

function observedProjectilePosition(projectile: Missile, visualState: InterpolatedWorld, now: number, boardSize: number) {
  if (projectile.record.status === "exploding") {
    return {
      x: projectile.position.x,
      y: projectile.position.y,
      height: projectile.record.height ?? 0,
    };
  }

  const observed = visualState.projectilePosition(projectile, now);
  const position = clampBoardPoint(observed, boardSize);
  return {
    ...position,
    height: Math.max(0, observed.height),
  };
}

type GroundPoint = {
  key: string;
  position: { x: number; y: number };
};

type GroundPointState = {
  targetPosition: { x: number; y: number };
  targetVelocity: { x: number; y: number };
  targetUpdatedAt: number;
  renderedPosition: { x: number; y: number };
  renderedVelocity: { x: number; y: number };
  lastRenderedAt: number;
};

function useInterpolatedGroundPoints(points: GroundPoint[], now: number) {
  const statesRef = useRef(new Map<string, GroundPointState>());
  const activeKeys = new Set<string>();
  const rendered = new Map<string, { x: number; y: number }>();

  for (const point of points) {
    activeKeys.add(point.key);
    const state = rememberGroundPoint(statesRef.current, point, now);
    rendered.set(point.key, renderGroundPoint(state, now));
  }

  for (const key of statesRef.current.keys()) {
    if (!activeKeys.has(key)) {
      statesRef.current.delete(key);
    }
  }

  return rendered;
}

function rememberGroundPoint(states: Map<string, GroundPointState>, point: GroundPoint, now: number) {
  const previous = states.get(point.key);
  if (!previous) {
    const state = {
      targetPosition: point.position,
      targetVelocity: { x: 0, y: 0 },
      targetUpdatedAt: now,
      renderedPosition: point.position,
      renderedVelocity: { x: 0, y: 0 },
      lastRenderedAt: now,
    };
    states.set(point.key, state);
    return state;
  }

  const targetDt = Math.max(1, now - previous.targetUpdatedAt);
  previous.targetVelocity = dividePoint(subtractPoint(point.position, previous.targetPosition), targetDt);
  previous.targetPosition = point.position;
  previous.targetUpdatedAt = now;
  return previous;
}

function renderGroundPoint(state: GroundPointState, now: number) {
  const frameDt = Math.max(0, now - state.lastRenderedAt);
  if (frameDt <= 0) {
    return state.renderedPosition;
  }

  const physicsPosition = advancePoint(state.renderedPosition, state.renderedVelocity, frameDt);
  state.renderedPosition = emaPoint(physicsPosition, state.targetPosition, RENDER_EMA_WEIGHT);
  state.renderedVelocity = emaPoint(state.renderedVelocity, state.targetVelocity, RENDER_EMA_WEIGHT);
  state.lastRenderedAt = now;
  return state.renderedPosition;
}

function advancePoint(point: { x: number; y: number }, velocity: { x: number; y: number }, elapsedMs: number) {
  return {
    x: point.x + velocity.x * elapsedMs,
    y: point.y + velocity.y * elapsedMs,
  };
}

function subtractPoint(a: { x: number; y: number }, b: { x: number; y: number }) {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
  };
}

function dividePoint(point: { x: number; y: number }, scalar: number) {
  return {
    x: point.x / scalar,
    y: point.y / scalar,
  };
}

function emaPoint(current: { x: number; y: number }, target: { x: number; y: number }, weight: number) {
  return {
    x: current.x + (target.x - current.x) * weight,
    y: current.y + (target.y - current.y) * weight,
  };
}

type InterpolatedWorld = {
  tankPose: (tank: Tank, now: number) => { x: number; y: number; bearing: number; aim: number };
  tankPosition: (tank: Tank, now: number) => { x: number; y: number };
  projectilePosition: (projectile: Missile, now: number) => { x: number; y: number; height: number };
};

type InterpolatedParams = {
  x: number;
  y: number;
  height: number;
  bearing: number;
  aim: number;
};

type InterpolationSnapshot = {
  key: string;
  serverUpdatedAt: number;
  params: InterpolatedParams;
  velocity: InterpolatedParams;
};

type ServerSnapshot = {
  serverUpdatedAt: number;
  params: InterpolatedParams;
  velocity: InterpolatedParams;
};

type InterpolationState = {
  previousServer: ServerSnapshot;
  latestServer: ServerSnapshot;
  segmentStartedAt: number;
  segmentDurationMs: number;
  renderedParams: InterpolatedParams;
  renderedVelocity: InterpolatedParams;
  lastRenderedAt: number;
};

function useInterpolatedWorld(gameRoom: GameRoom | null, enabled = true): InterpolatedWorld {
  const statesRef = useRef(new Map<string, InterpolationState>());
  const snapshots = useMemo(() => {
    if (!enabled) {
      return [];
    }

    const tankSnapshots = gameRoom?.tanks.map((tank) => ({
      key: `tank:${tank.id}`,
      serverUpdatedAt: tank.record.updatedAt,
      params: {
        x: tank.position.x,
        y: tank.position.y,
        height: 0,
        bearing: angleFromDirection(tank.record.hullDirection),
        aim: angleFromDirection(tank.record.turretDirection),
      },
      velocity: {
        x: tank.velocity.x,
        y: tank.velocity.y,
        height: 0,
        bearing: 0,
        aim: 0,
      },
    })) ?? [];
    const projectileSnapshots = gameRoom?.projectiles.map((projectile) => ({
      key: `projectile:${projectile.record._id}`,
      serverUpdatedAt: projectile.record.updatedAt,
      params: {
        x: projectile.position.x,
        y: projectile.position.y,
        height: projectile.record.height ?? 0,
        bearing: 0,
        aim: 0,
      },
      velocity: {
        x: projectile.velocity.x,
        y: projectile.velocity.y,
        height: projectile.record.verticalVelocity ?? 0,
        bearing: 0,
        aim: 0,
      },
    })) ?? [];
    return [...tankSnapshots, ...projectileSnapshots];
  }, [gameRoom?.tanks, gameRoom?.projectiles]);
  const snapshotSignature = useMemo(
    () =>
      snapshots
        .map((snapshot) =>
          `${snapshot.key}:${snapshot.serverUpdatedAt}:${snapshot.params.x}:${snapshot.params.y}:${snapshot.params.height}:${snapshot.params.bearing}:${snapshot.params.aim}:${snapshot.velocity.x}:${snapshot.velocity.y}:${snapshot.velocity.height}`,
        )
        .join("|"),
    [snapshots],
  );

  useEffect(() => {
    if (!enabled) {
      statesRef.current.clear();
      return;
    }

    const localReceivedAt = Date.now();
    const activeKeys = new Set<string>();

    for (const snapshot of snapshots) {
      activeKeys.add(snapshot.key);
      rememberInterpolationSnapshot(statesRef.current, snapshot, localReceivedAt);
    }

    for (const key of statesRef.current.keys()) {
      if (!activeKeys.has(key)) {
        statesRef.current.delete(key);
      }
    }
  }, [enabled, snapshotSignature, snapshots]);

  return useMemo(() => ({
    tankPose: (tank: Tank, now: number) => {
      if (!enabled) {
        return {
          x: tank.position.x,
          y: tank.position.y,
          bearing: angleFromDirection(tank.record.hullDirection),
          aim: angleFromDirection(tank.record.turretDirection),
        };
      }

      const params = readInterpolatedParams(statesRef.current, `tank:${tank.id}`, now, tankFallbackParams(tank));
      return {
        x: params.x,
        y: params.y,
        bearing: params.bearing,
        aim: params.aim,
      };
    },
    tankPosition: (tank: Tank, now: number) => {
      if (!enabled) {
        return { x: tank.position.x, y: tank.position.y };
      }

      const params = readInterpolatedParams(statesRef.current, `tank:${tank.id}`, now, tankFallbackParams(tank));
      return { x: params.x, y: params.y };
    },
    projectilePosition: (projectile: Missile, now: number) => {
      if (!enabled) {
        return {
          x: projectile.position.x,
          y: projectile.position.y,
          height: projectile.record.height ?? 0,
          bearing: 0,
          aim: 0,
        };
      }

      return readInterpolatedParams(statesRef.current, `projectile:${projectile.record._id}`, now, {
        x: projectile.position.x,
        y: projectile.position.y,
        height: projectile.record.height ?? 0,
        bearing: 0,
        aim: 0,
      });
    },
  }), [enabled]);
}

function tankFallbackParams(tank: Tank): InterpolatedParams {
  return {
    x: tank.position.x,
    y: tank.position.y,
    height: 0,
    bearing: angleFromDirection(tank.record.hullDirection),
    aim: angleFromDirection(tank.record.turretDirection),
  };
}

function rememberInterpolationSnapshot(states: Map<string, InterpolationState>, snapshot: InterpolationSnapshot, localReceivedAt: number) {
  const previous = states.get(snapshot.key);
  if (!previous) {
    const velocity = serverVelocityPerMs(snapshot.velocity);
    states.set(snapshot.key, {
      previousServer: snapshot,
      latestServer: snapshot,
      segmentStartedAt: localReceivedAt,
      segmentDurationMs: DEFAULT_SEGMENT_MS,
      renderedParams: snapshot.params,
      renderedVelocity: velocity,
      lastRenderedAt: localReceivedAt,
    });
    return;
  }

  if (snapshot.serverUpdatedAt <= previous.latestServer.serverUpdatedAt) {
    return;
  }

  const nextSnapshot = alignSnapshotAngles(snapshot, previous.latestServer.params);
  const current = renderedStateAt(previous, localReceivedAt);
  const segmentDurationMs = serverIntervalDuration(nextSnapshot.serverUpdatedAt - previous.latestServer.serverUpdatedAt);

  states.set(snapshot.key, {
    previousServer: previous.latestServer,
    latestServer: nextSnapshot,
    segmentStartedAt: localReceivedAt,
    segmentDurationMs,
    renderedParams: current.params,
    renderedVelocity: current.velocity,
    lastRenderedAt: localReceivedAt,
  });
}

function alignSnapshotAngles(snapshot: InterpolationSnapshot, previousParams: InterpolatedParams): InterpolationSnapshot {
  return {
    ...snapshot,
    params: {
      ...snapshot.params,
      bearing: unwrapAngle(previousParams.bearing, snapshot.params.bearing),
      aim: unwrapAngle(previousParams.aim, snapshot.params.aim),
    },
  };
}

function readInterpolatedParams(states: Map<string, InterpolationState>, key: string, now: number, fallback: InterpolatedParams) {
  const state = states.get(key);
  return state ? paramsAt(state, now) : fallback;
}

function paramsAt(state: InterpolationState, now: number) {
  return renderedStateAt(state, now).params;
}

function renderedStateAt(state: InterpolationState, now: number) {
  const frameDt = Math.max(0, now - state.lastRenderedAt);
  if (frameDt <= 0) {
    return {
      params: state.renderedParams,
      velocity: state.renderedVelocity,
    };
  }

  const raw = rawSegmentStateAt(state, now);
  const physicsParams = advanceParams(state.renderedParams, state.renderedVelocity, frameDt);
  state.renderedParams = emaParams(physicsParams, raw.params, RENDER_EMA_WEIGHT);
  state.renderedVelocity = emaParams(state.renderedVelocity, raw.velocity, RENDER_EMA_WEIGHT);
  state.lastRenderedAt = now;

  return {
    params: state.renderedParams,
    velocity: state.renderedVelocity,
  };
}

function rawSegmentStateAt(state: InterpolationState, now: number) {
  const elapsed = Math.max(0, now - state.segmentStartedAt);
  const durationMs = Math.max(1, state.segmentDurationMs);
  const startVelocity = withAngularSegmentVelocity(
    serverVelocityPerMs(state.previousServer.velocity),
    state.previousServer.params,
    state.latestServer.params,
    durationMs,
  );
  const endVelocity = withAngularSegmentVelocity(
    serverVelocityPerMs(state.latestServer.velocity),
    state.previousServer.params,
    state.latestServer.params,
    durationMs,
  );

  if (elapsed >= durationMs) {
    return {
      params: state.latestServer.params,
      velocity: endVelocity,
    };
  }

  const progress = elapsed / durationMs;

  return {
    params: interpolateParams(state.previousServer.params, state.latestServer.params, progress),
    velocity: interpolateParams(startVelocity, endVelocity, progress),
  };
}

function advanceParams(params: InterpolatedParams, velocity: InterpolatedParams, elapsedMs: number) {
  return {
    x: params.x + velocity.x * elapsedMs,
    y: params.y + velocity.y * elapsedMs,
    height: params.height + velocity.height * elapsedMs,
    bearing: params.bearing + velocity.bearing * elapsedMs,
    aim: params.aim + velocity.aim * elapsedMs,
  };
}

function divideParams(params: InterpolatedParams, scalar: number) {
  return {
    x: params.x / scalar,
    y: params.y / scalar,
    height: params.height / scalar,
    bearing: params.bearing / scalar,
    aim: params.aim / scalar,
  };
}

function subtractParams(a: InterpolatedParams, b: InterpolatedParams) {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    height: a.height - b.height,
    bearing: a.bearing - b.bearing,
    aim: a.aim - b.aim,
  };
}

function interpolateParams(a: InterpolatedParams, b: InterpolatedParams, progress: number) {
  return {
    x: a.x + (b.x - a.x) * progress,
    y: a.y + (b.y - a.y) * progress,
    height: a.height + (b.height - a.height) * progress,
    bearing: interpolateAngle(a.bearing, b.bearing, progress),
    aim: interpolateAngle(a.aim, b.aim, progress),
  };
}

function emaParams(current: InterpolatedParams, target: InterpolatedParams, weight: number) {
  return interpolateParams(current, target, weight);
}

function serverVelocityPerMs(velocity: InterpolatedParams) {
  return divideParams(velocity, SERVER_TICK_MS);
}

function withAngularSegmentVelocity(
  velocity: InterpolatedParams,
  from: InterpolatedParams,
  to: InterpolatedParams,
  durationMs: number,
) {
  const segmentVelocity = divideParams(subtractParams(to, from), durationMs);
  return {
    ...velocity,
    bearing: segmentVelocity.bearing,
    aim: segmentVelocity.aim,
  };
}

function serverIntervalDuration(serverIntervalMs: number) {
  if (serverIntervalMs <= 0) {
    return DEFAULT_SEGMENT_MS;
  }
  return serverIntervalMs;
}

function launchVelocity(power: number, angle: number) {
  const launchAngle = Math.max(10, Math.min(60, angle));
  const radians = (launchAngle * Math.PI) / 180;
  const targetRange = fullPowerRangeForAngle(launchAngle) * (power / 100);
  const launchSpeed = Math.sqrt(targetRange * 48 / Math.sin(2 * radians));
  return {
    horizontal: Math.cos(radians) * launchSpeed,
    vertical: Math.sin(radians) * launchSpeed,
  };
}

function fullPowerRangeForAngle(angle: number) {
  if (angle <= 30) {
    return 8000;
  }
  if (angle <= 45) {
    return interpolate(angle, 30, 8000, 45, 6000);
  }
  return interpolate(angle, 45, 6000, 60, 4000);
}

function interpolate(value: number, from: number, fromValue: number, to: number, toValue: number) {
  const t = (value - from) / (to - from);
  return fromValue + (toValue - fromValue) * t;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function vectorFromBearing(degrees: number, magnitude: number) {
  const radians = ((normalizeDegrees(degrees) - 90) * Math.PI) / 180;
  return {
    x: Math.cos(radians) * magnitude,
    y: Math.sin(radians) * magnitude,
  };
}

function clampBoardPoint(point: { x: number; y: number }, boardSize: number) {
  const min = 1000;
  const max = boardSize * 1000 - 1000;
  return {
    x: Math.max(min, Math.min(max, point.x)),
    y: Math.max(min, Math.min(max, point.y)),
  };
}

function perspectiveSizeForHeight(height: number) {
  const cameraDistance = Math.max(PROJECTILE_CAMERA_HEIGHT_UNITS * 0.35, PROJECTILE_CAMERA_HEIGHT_UNITS - height);
  const projectedSize = CANNON_WIDTH_PX * (PROJECTILE_CAMERA_HEIGHT_UNITS / cameraDistance);
  return Math.min(MAX_PROJECTILE_SIZE_PX, Math.max(CANNON_WIDTH_PX, projectedSize));
}

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}

function interpolateAngle(from: number, to: number, progress: number) {
  return from + shortestAngleDelta(from, to) * progress;
}

function unwrapAngle(from: number, to: number) {
  return from + shortestAngleDelta(from, to);
}

function shortestAngleDelta(from: number, to: number) {
  return ((to - from + 540) % 360) - 180;
}

function angleFromDirection(direction: Tank["record"]["hullDirection"]) {
  if (typeof direction === "number") {
    return direction;
  }

  return {
    north: 0,
    east: 90,
    south: 180,
    west: 270,
  }[direction];
}
