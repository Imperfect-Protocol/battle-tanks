import { useEffect, useMemo, useState } from "react";
import { useGameRoom } from "./hooks/useGameRoom";
import type { Tank } from "./libs/Tank";

const DEFAULT_ROOM = "WWEFFP";
const GAME_TICK_MS = 40;
const CANNON_WIDTH_PX = 4;
const PROJECTILE_CAMERA_HEIGHT_UNITS = 16000;
const MAX_PROJECTILE_SIZE_PX = 18;

export default function App() {
  const [roomCode, setRoomCode] = useState(DEFAULT_ROOM);
  const [playerName, setPlayerName] = useState(() => `Commander ${Math.floor(Math.random() * 90 + 10)}`);
  const [script, setScript] = useState("forward 20\nright 30\nforward 20\nturret -50\nfire 70 45");
  const { gameRoom, createRoom, joinRoom, submitScript, runNextTick } = useGameRoom(roomCode);
  const tankByPlayer = useMemo(() => new Map(gameRoom?.tanks.map((tank) => [tank.playerId, tank]) ?? []), [gameRoom]);
  const localPlayer = gameRoom?.players.find((player) => player.name === cleanPlayerName(playerName));
  const ownsClock = localPlayer?.slot === "alpha";
  const roomExists = Boolean(gameRoom?.match);
  const hasJoinedRoom = Boolean(localPlayer);

  function enterRoom() {
    if (roomExists) {
      void joinRoom({ roomCode, playerName });
      return;
    }

    void createRoom({ roomCode, playerName });
  }

  async function executeScript() {
    await submitScript(playerName, script);
    if (ownsClock) {
      void runNextTick({ roomCode });
    }
  }

  function handleTerminalKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      void executeScript();
    }
  }

  useEffect(() => {
    if (!gameRoom?.match || !ownsClock) {
      return;
    }

    const timer = window.setInterval(() => {
      void runNextTick({ roomCode });
    }, GAME_TICK_MS);

    return () => window.clearInterval(timer);
  }, [gameRoom?.match, ownsClock, roomCode, runNextTick]);

  return (
    <main className="shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">Battle Tanks</p>
          <h1>Script orders. Share the battlefield.</h1>
        </div>
        <div className="status-pill">
          Convex realtime room {roomCode}
        </div>
      </section>

      <section className="panel status-panel">
        <div className="room-state">
          <div>
            <h2>Room State</h2>
            <p>Status {gameRoom?.match?.status ?? "not created"}</p>
          </div>
        </div>
        <div className="commanders">
          <h2>Commanders</h2>
          <div className="commander-list">
            {gameRoom?.players.map((player) => {
              const tank = tankByPlayer.get(player.id);
              return (
                <div className="player-row" key={player.id}>
                  <span>{player.name}</span>
                  <strong>{tank?.health ?? 0} hp</strong>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="layout">
        <aside className="panel controls">
          <label>
            Room
            <input value={roomCode} onChange={(event) => setRoomCode(event.target.value.toUpperCase())} />
          </label>
          <label>
            Commander
            <input value={playerName} onChange={(event) => setPlayerName(event.target.value)} />
          </label>
          {!hasJoinedRoom && (
            <button className="primary" onClick={enterRoom}>
              {roomExists ? "Join" : "Create"}
            </button>
          )}
          {hasJoinedRoom && (
            <>
              <label className="terminal-panel">
                Terminal
                <textarea
                  className="terminal-input"
                  spellCheck={false}
                  value={script}
                  onChange={(event) => setScript(event.target.value)}
                  onKeyDown={handleTerminalKeyDown}
                />
              </label>
              <button className="primary" onClick={() => void executeScript()}>
                Run
              </button>
            </>
          )}
        </aside>

        <section className="arena-wrap">
          <div className="arena" style={{ "--cells": gameRoom?.board?.size ?? 12 } as React.CSSProperties}>
            {gameRoom?.board?.walls.map((wall) => (
              <div key={`${wall.x}-${wall.y}`} className="wall" style={cellStyle(wall.x, wall.y)} />
            ))}
            {gameRoom?.tanks.map((tank) => (
              <TankPiece
                key={tank.id}
                tank={tank}
                boardSize={gameRoom?.board?.size ?? 12}
                name={gameRoom.players.find((player) => player.id === tank.playerId)?.name ?? "Tank"}
              />
            ))}
            {gameRoom?.projectiles.map((projectile) => (
              <div
                key={projectile.record._id}
                className={projectile.record.status === "exploding" ? "projectile projectile--exploding" : "projectile"}
                style={projectileStyle(projectile.position.x, projectile.position.y, projectile.record.height ?? 0, gameRoom?.board?.size ?? 12)}
              />
            ))}
          </div>
        </section>

      </section>
    </main>
  );
}

function TankPiece({ tank, boardSize, name }: { tank: Tank; boardSize: number; name: string }) {
  const hullRotation = normalizeDegrees(angleFromDirection(tank.record.hullDirection));
  const turretHeading = normalizeDegrees(angleFromDirection(tank.record.turretDirection));
  const turretRotation = normalizeDegrees(turretHeading - hullRotation);
  return (
    <div
      className="tank"
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
      <i className="tank-turret">
        <i className="tank-barrel" />
        <span>{name.slice(0, 2).toUpperCase()}</span>
      </i>
    </div>
  );
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
  return (((degrees % 360) + 360) % 360);
}

function cleanPlayerName(name: string) {
  return name.trim().slice(0, 32) || "Commander";
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
