import { useEffect, useMemo, useState } from "react";
import type { GameRoom } from "../libs/GameRoom";
import type { Tank } from "../libs/Tank";

const CANNON_WIDTH_PX = 4;
const PROJECTILE_CAMERA_HEIGHT_UNITS = 16000;
const MAX_PROJECTILE_SIZE_PX = 18;
const DEFAULT_BOARD_SIZE = 12;

type BattleBoardProps = {
  gameRoom: GameRoom | null;
};

export function BattleBoard({ gameRoom }: BattleBoardProps) {
  const boardSize = gameRoom?.board?.size ?? DEFAULT_BOARD_SIZE;
  const walls = useMemo(() => gameRoom?.board?.walls ?? defaultWalls(boardSize), [gameRoom?.board, boardSize]);
  const [now, setNow] = useState(Date.now());
  const projectiles = useMemo(
    () =>
      gameRoom?.projectiles.filter(
        (projectile) =>
          projectile.record.status !== "exploding" ||
          projectile.record.explosionEndsAt === undefined ||
          projectile.record.explosionEndsAt > now,
      ) ?? [],
    [gameRoom?.projectiles, now],
  );

  useEffect(() => {
    const hasExplosions = gameRoom?.projectiles.some((projectile) => projectile.record.status === "exploding");
    if (!hasExplosions) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 80);
    return () => window.clearInterval(timer);
  }, [gameRoom?.projectiles]);

  return (
    <div className="arena" style={{ "--cells": boardSize } as React.CSSProperties}>
      {walls.map((wall) => (
        <div key={`${wall.x}-${wall.y}`} className="wall" style={cellStyle(wall.x, wall.y)} />
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

function TankPiece({ tank, boardSize, name }: { tank: Tank; boardSize: number; name: string }) {
  const hullRotation = normalizeDegrees(angleFromDirection(tank.record.hullDirection));
  const turretHeading = normalizeDegrees(angleFromDirection(tank.record.turretDirection));
  const turretRotation = normalizeDegrees(turretHeading - hullRotation);
  const isDestroyed = tank.health <= 0;

  return (
    <div
      className={isDestroyed ? "tank tank--destroyed" : "tank"}
      style={
        {
          ...pointStyle(tank.position.x, tank.position.y, boardSize),
          "--hull-rotation": `${hullRotation}deg`,
          "--turret-rotation": `${turretRotation}deg`,
          "--turret-label-rotation": `${-turretHeading}deg`,
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
    east: 0,
    south: 90,
    west: 180,
    north: 270,
  }[direction];
}
