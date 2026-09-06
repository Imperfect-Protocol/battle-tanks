import { useEffect, useMemo, useState } from "react";
import type { GameRoom } from "../libs/GameRoom";
import type { Tank } from "../libs/Tank";
import { normalizeTankSpec, tankSpecStyle } from "./TankAvatar";

const CANNON_WIDTH_PX = 4;
const PROJECTILE_CAMERA_HEIGHT_UNITS = 16000;
const MAX_PROJECTILE_SIZE_PX = 18;
const DEFAULT_BOARD_SIZE = 12;
const GAME_TICK_MS = 40;

type BattleBoardProps = {
  gameRoom: GameRoom | null;
  localPlayerId?: string | null;
};

export function BattleBoard({ gameRoom, localPlayerId = null }: BattleBoardProps) {
  const boardSize = gameRoom?.board?.size ?? DEFAULT_BOARD_SIZE;
  const walls = useMemo(() => gameRoom?.board?.walls ?? defaultWalls(boardSize), [gameRoom?.board, boardSize]);
  const [frameNow, setFrameNow] = useState(Date.now());
  const localTank = gameRoom?.tanks.find((tank) => tank.playerId === localPlayerId && tank.alive);
  const aimImpact = localTank ? predictProjectileImpact(localTank, boardSize, frameNow, localTank.record.cannonPower ?? localTank.record.lastFirePower ?? 50) : null;
  const targetMarkers = localTank && aimImpact
    ? gameRoom?.tanks
      .filter((tank) => tank.playerId !== localPlayerId && tank.alive)
      .map((tank) => ({
        id: tank.id,
        color: normalizeTankSpec(localTank.record.tankSpec).hullColor,
        position: clampBoardPoint({
          x: observedTankPosition(tank, frameNow, boardSize).x + tank.velocity.x * aimImpact.flightTicks,
          y: observedTankPosition(tank, frameNow, boardSize).y + tank.velocity.y * aimImpact.flightTicks,
        }, boardSize),
      })) ?? []
    : [];
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
        />
      )}
      {targetMarkers.map((target) => (
        <GroundTarget
          key={target.id}
          className="target-marker"
          color={target.color}
          position={target.position}
          boardSize={boardSize}
        />
      ))}
      {gameRoom?.tanks.map((tank) => (
        <TankPiece
          key={tank.id}
          tank={tank}
          boardSize={boardSize}
          name={gameRoom.players.find((player) => player.id === tank.playerId)?.name ?? "Tank"}
        />
      ))}
      {projectiles.map((projectile) => (
        <div
          key={projectile.record._id}
          className={projectile.record.status === "exploding" ? "projectile projectile--exploding" : "projectile"}
          style={projectileStyle(projectile.position.x, projectile.position.y, projectile.record.height ?? 0, boardSize)}
        />
      ))}
    </div>
  );
}

function GroundTarget({
  className,
  color,
  position,
  boardSize,
}: {
  className: string;
  color: string;
  position: { x: number; y: number };
  boardSize: number;
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
      <i className="ground-target__ring ground-target__ring--outer" />
      <i className="ground-target__ring ground-target__ring--inner" />
      <i className="ground-target__line ground-target__line--horizontal" />
      <i className="ground-target__line ground-target__line--vertical" />
    </div>
  );
}

function TankPiece({ tank, boardSize, name }: { tank: Tank; boardSize: number; name: string }) {
  const hullRotation = normalizeDegrees(angleFromDirection(tank.record.hullDirection));
  const turretHeading = normalizeDegrees(angleFromDirection(tank.record.turretDirection));
  const turretRotation = normalizeDegrees(turretHeading - hullRotation);
  const tankSpec = normalizeTankSpec(tank.record.tankSpec);
  const isDestroyed = tank.health <= 0;

  return (
    <div
      className={isDestroyed ? "tank tank--destroyed" : "tank"}
      style={
        {
          ...pointStyle(tank.position.x, tank.position.y, boardSize),
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

function predictProjectileImpact(tank: Tank, boardSize: number, now: number, power: number) {
  const tankSpec = normalizeTankSpec(tank.record.tankSpec);
  const launch = launchVelocity(power, tank.record.launchAngle ?? 45);
  const muzzleVelocity = vectorFromBearing(angleFromDirection(tank.record.turretDirection), launch.horizontal);
  const velocity = {
    x: muzzleVelocity.x + tank.velocity.x,
    y: muzzleVelocity.y + tank.velocity.y,
  };
  const mountOffset = vectorFromBearing(
    angleFromDirection(tank.record.hullDirection),
    (tankSpec.turretOffset - 0.5) * 1180,
  );
  const barrelVector = vectorFromBearing(
    angleFromDirection(tank.record.turretDirection),
    (tankSpec.turretSize * 620) / 2 + tankSpec.cannonLength * 1180,
  );
  const tankPosition = observedTankPosition(tank, now, boardSize);
  const muzzle = {
    x: tankPosition.x + mountOffset.x + barrelVector.x,
    y: tankPosition.y + mountOffset.y + barrelVector.y,
  };
  const flightTicks = Math.max(1, (2 * launch.vertical) / 48);
  return {
    flightTicks,
    position: clampBoardPoint({
      x: muzzle.x + velocity.x * flightTicks,
      y: muzzle.y + velocity.y * flightTicks,
    }, boardSize),
  };
}

function observedTankPosition(tank: Tank, now: number, boardSize: number) {
  const elapsedTicks = Math.max(0, Math.min(4, (now - tank.record.updatedAt) / GAME_TICK_MS));
  return clampBoardPoint({
    x: tank.position.x + tank.velocity.x * elapsedTicks,
    y: tank.position.y + tank.velocity.y * elapsedTicks,
  }, boardSize);
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
