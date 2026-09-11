import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCommander } from "../app/CommanderContext";
import { BattleBoard } from "../components/BattleBoard";
import { BattleConsole } from "../components/BattleConsole";
import { NavigationRose } from "../components/NavigationRose";
import { useGameRoom } from "../hooks/useGameRoom";
import { allowTabCloseWithoutPrompt, closeCurrentTab } from "../libs/browserTab";
import type { GameRoom } from "../libs/GameRoom";
import type { Tank } from "../libs/Tank";

const GAME_TICK_MS = 500;
const GAME_OVER_DELAY_MS = 3000;
const STANDBY_AFTER_MS = 2 * 60 * 1000;
const HELP_TEXT = "COMMANDS: bear/b <00-36>, move/m <-10..10> squares, aim/a <00-36>, elev/e <10-60>, pow/p <10-100>, fire/f, ret/r";

export function BattlePage() {
  const navigate = useNavigate();
  const { roomCode = "" } = useParams();
  const [searchParams] = useSearchParams();
  const { displayName, commanderId } = useCommander();
  const [pendingRoomCode] = useState(createRoomCode);
  const isNewBattleRoute = roomCode.toLowerCase() === "new";
  const cleanRoomCode = isNewBattleRoute ? pendingRoomCode : roomCode.toUpperCase();
  const [battleName, setBattleName] = useState("");
  const [battleNameError, setBattleNameError] = useState("");
  const joinAttemptedRef = useRef(false);
  const tickInFlightRef = useRef<Promise<unknown> | null>(null);
  const { gameRoom, createRoom, joinRoom, submitScript, tickPlayer } = useGameRoom(cleanRoomCode, commanderId ?? undefined);
  const tankByPlayer = useMemo(() => new Map(gameRoom?.tanks.map((tank) => [tank.playerId, tank]) ?? []), [gameRoom]);
  const localPlayer = gameRoom?.players.find((player) => player.commanderId === commanderId);
  const localTank = localPlayer ? tankByPlayer.get(localPlayer.id) : null;
  const observedEvents = useMemo(
    () =>
      gameRoom?.events
        .filter((event) => event.sourcePlayerId !== localPlayer?.id && event.expiresAt > Date.now())
        .map((event) => ({
          eventId: event._id,
          sourcePlayerId: event.sourcePlayerId,
          targetTankId: event.targetTankId,
          type: event.type,
          position: event.position,
          normal: event.normal,
          radius: event.radius,
          damage: event.damage,
          penetration: event.penetration,
          expiresAt: event.expiresAt,
        }))
        .slice(0, 20) ?? [],
    [gameRoom?.events, localPlayer?.id],
  );
  const ownsClock = Boolean(localPlayer);
  const roomExists = Boolean(gameRoom?.match);
  const hasJoinedRoom = Boolean(localPlayer);
  const isCreateRoute = isNewBattleRoute || searchParams.get("create") === "1";
  const isJoinRoute = searchParams.get("join") === "1";
  const destroyedTank = gameRoom?.tanks.find((tank) => tank.health <= 0);
  const destroyedPlayer = gameRoom?.players.find((player) => player.id === destroyedTank?.playerId);
  const winnerPlayer = gameRoom?.players.find((player) => player.id === gameRoom.match?.winnerPlayerId);
  const [now, setNow] = useState(Date.now());
  const showGameOver = Boolean(
    gameRoom?.match?.status === "finished" &&
      gameRoom.match.finishedAt &&
      now - gameRoom.match.finishedAt >= GAME_OVER_DELAY_MS,
  );

  useEffect(() => allowTabCloseWithoutPrompt(), []);

  useEffect(() => {
    if (!gameRoom?.match || !ownsClock || !commanderId || !shouldSendEmptyTick(gameRoom, localTank, observedEvents.length)) {
      return;
    }

    const timer = window.setInterval(() => {
      if (tickInFlightRef.current) {
        return;
      }
      const tick = tickPlayer(commanderId, observedEvents);
      tickInFlightRef.current = tick;
      void tick.finally(() => {
        if (tickInFlightRef.current === tick) {
          tickInFlightRef.current = null;
        }
      });
    }, GAME_TICK_MS);

    return () => window.clearInterval(timer);
  }, [commanderId, gameRoom, localTank, observedEvents, ownsClock, tickPlayer]);

  useEffect(() => {
    if (!gameRoom?.match || showGameOver) {
      return;
    }

    let lastActivityAt = Date.now();
    let timer = 0;
    const recordActivity = () => {
      lastActivityAt = Date.now();
    };
    const checkIdle = () => {
      if (Date.now() - lastActivityAt >= STANDBY_AFTER_MS) {
        navigate(`/battle/${cleanRoomCode}/stand-by`, { replace: true });
        return;
      }
      timer = window.setTimeout(checkIdle, 1000);
    };
    const events = ["keydown", "mousedown", "mousemove", "pointerdown", "touchstart", "wheel"];

    for (const eventName of events) {
      window.addEventListener(eventName, recordActivity, { passive: true });
    }
    timer = window.setTimeout(checkIdle, 1000);

    return () => {
      window.clearTimeout(timer);
      for (const eventName of events) {
        window.removeEventListener(eventName, recordActivity);
      }
    };
  }, [cleanRoomCode, gameRoom?.match, navigate, showGameOver]);

  useEffect(() => {
    if (!isJoinRoute || !roomExists || hasJoinedRoom || joinAttemptedRef.current) {
      return;
    }

    joinAttemptedRef.current = true;
    if (!commanderId) {
      return;
    }

    void joinRoom({ roomCode: cleanRoomCode, commanderId }).then(() => {
      navigate(`/battle/${cleanRoomCode}`, { replace: true });
    });
  }, [cleanRoomCode, commanderId, hasJoinedRoom, isJoinRoute, joinRoom, navigate, roomExists]);

  useEffect(() => {
    if (!gameRoom?.match?.finishedAt) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [gameRoom?.match?.finishedAt]);

  const createBattle = async (event: FormEvent) => {
    event.preventDefault();
    if (!commanderId) {
      return;
    }

    setBattleNameError("");
    try {
      await createRoom({ roomCode: cleanRoomCode, commanderId, battleName });
      navigate(`/battle/${cleanRoomCode}`, { replace: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Battle already exists";
      setBattleNameError(message.includes("already") ? "Battle already exists" : message);
    }
  };

  const submitCommand = async (command: string) => {
    if (command.trim().toLowerCase() === "help") {
      return HELP_TEXT;
    }

    if (!commanderId) {
      throw new Error("Choose a commander before submitting orders");
    }

    await tickInFlightRef.current;
    await submitScript(commanderId, command, observedEvents);
    return describeCommand(command);
  };

  const closeBattleTab = () => {
    closeCurrentTab();
    window.setTimeout(() => {
      if (!window.closed) {
        navigate("/lobbies/pvp");
      }
    }, 120);
  };

  return (
    <main className="screen battle-screen">
      <header className="app-header battle-header">
        <Link className="brand-lockup" to="/">
          <span>BATTLE TANKS</span>
          <strong>{readBattleName(gameRoom?.match)}</strong>
        </Link>
        <div className="room-chip">{cleanRoomCode}</div>
      </header>

      <section className="battle-status-strip">
        <div>
          <span>Status</span>
          <strong>{statusLabel(gameRoom?.match?.status, gameRoom?.ready ?? false)}</strong>
        </div>
        <div>
          <span>Commanders</span>
          <div className="commander-list commander-list--strip">
            {gameRoom?.players.map((player) => {
              const tank = tankByPlayer.get(player.id);
              return (
                <div className="commander-row" key={player.id}>
                  <span>{player.name}</span>
                  <strong>{tank?.health ?? 0} hp</strong>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <section className="battle-workbench">
        <div className="board-stage">
          <BattleBoard gameRoom={gameRoom} localPlayerId={localPlayer?.id ?? null} />
          {isCreateRoute && !roomExists && (
            <div className="battle-dialog">
              <form className="protocol-panel battle-dialog__panel" onSubmit={createBattle}>
                <p className="eyebrow">Create Battle</p>
                <label className="field">
                  <span>Name</span>
                  <input
                    autoFocus
                    placeholder="Battle"
                    value={battleName}
                    onChange={(event) => {
                      setBattleName(event.target.value);
                      setBattleNameError("");
                    }}
                  />
                  {battleNameError && <small className="field-error">{battleNameError}</small>}
                </label>
                <div className="dialog-stat">
                  <span>Players</span>
                  <strong>2</strong>
                </div>
                <button className="button button--primary" type="submit">
                  Create
                </button>
              </form>
            </div>
          )}
          {roomExists && hasJoinedRoom && !gameRoom?.ready && (
            <div className="battle-dialog">
              <div className="protocol-panel battle-dialog__panel">
                <p className="eyebrow">Battle</p>
                <h2>Waiting for other player</h2>
              </div>
            </div>
          )}
          {isJoinRoute && !roomExists && (
            <div className="battle-dialog">
              <div className="protocol-panel battle-dialog__panel">
                <p className="eyebrow">Battle</p>
                <h2>Battle not found</h2>
              </div>
            </div>
          )}
          {showGameOver && (
            <div className="battle-dialog">
              <div className="protocol-panel battle-dialog__panel game-over-panel">
                <p className="eyebrow">Game Over</p>
                <h2>{winnerPlayer ? `${winnerPlayer.name} wins` : `${destroyedPlayer?.name ?? "Tank"} destroyed`}</h2>
                <button className="button button--primary" type="button" onClick={closeBattleTab}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>

        {hasJoinedRoom && gameRoom?.ready && (
          <aside className="battle-control-stack">
            <BattleConsole commanderName={displayName} roomCode={cleanRoomCode} onCommand={submitCommand} />
            <NavigationRose tank={localTank} />
          </aside>
        )}
      </section>
    </main>
  );
}

function readBattleName(match: unknown) {
  if (match && typeof match === "object" && "battleName" in match && typeof match.battleName === "string") {
    return match.battleName;
  }
  return "Battle";
}

function shouldSendEmptyTick(gameRoom: GameRoom | null, localTank: Tank | null | undefined, observedEventCount: number) {
  if (!gameRoom?.match || gameRoom.match.status === "finished") {
    return false;
  }

  if (observedEventCount > 0 || gameRoom.ownPendingWork) {
    return true;
  }

  if (!localTank || localTank.health <= 0) {
    return false;
  }

  const remainingMove = Math.abs(localTank.record.moveRemaining ?? 0);
  const speed = Math.hypot(localTank.velocity.x, localTank.velocity.y);
  if (remainingMove > 0.5 || speed > 0.5) {
    return true;
  }

  return gameRoom.projectiles.some((projectile) => projectile.record.ownerTankId === localTank.id);
}

function statusLabel(status: string | undefined, ready: boolean) {
  if (status === "finished") {
    return "Finished";
  }
  if (ready || status === "active") {
    return "Live";
  }
  return "Waiting";
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = new Uint8Array(6);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function describeCommand(command: string) {
  const commands = command
    .split(/[;,\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (commands.length > 1) {
    return commands.map(describeSingleCommand).join("\n");
  }

  return describeSingleCommand(command);
}

function describeSingleCommand(command: string) {
  const [rawAction, rawAmount] = command.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
  const action = expandCommandAction(rawAction);
  const amount = Number(rawAmount);

  if (action === "bear" && Number.isFinite(amount)) {
    return `Bearing ${formatHeadingAmount(amount)} degrees`;
  }

  if (action === "aim" && Number.isFinite(amount)) {
    return `Aim ${formatHeadingAmount(amount)} degrees`;
  }

  if (action === "elev" && Number.isFinite(amount)) {
    return `Elevation ${amount} degrees`;
  }

  if (action === "pow" && Number.isFinite(amount)) {
    return `Power ${amount}%`;
  }

  if (action === "move" && Number.isFinite(amount)) {
    const squares = Math.abs(amount);
    return `Move ${squares} squares ${amount < 0 ? "backward" : "forward"}`;
  }

  if (action === "fire") {
    return "Fire";
  }

  if (action === "ret") {
    return "Turret returning to hull bearing";
  }

  return "Accepted";
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

function formatHeadingAmount(amount: number) {
  return normalizeDegrees(amount * 10);
}

function normalizeDegrees(degrees: number) {
  return ((degrees % 360) + 360) % 360;
}
