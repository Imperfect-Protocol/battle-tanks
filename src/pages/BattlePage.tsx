import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useCommander } from "../app/CommanderContext";
import { BattleBoard } from "../components/BattleBoard";
import { BattleConsole } from "../components/BattleConsole";
import { useGameRoom } from "../hooks/useGameRoom";

const GAME_TICK_MS = 40;
const GAME_OVER_DELAY_MS = 5000;
const HELP_TEXT = "COMMANDS: forward <points>, backward <points>, turn <degrees>, aim <degrees> <elevation>, fire <power>, lock, unlock, wait";

export function BattlePage() {
  const navigate = useNavigate();
  const { roomCode = "" } = useParams();
  const [searchParams] = useSearchParams();
  const { displayName, commanderId } = useCommander();
  const [battleName, setBattleName] = useState("Battle");
  const joinAttemptedRef = useRef(false);
  const cleanRoomCode = roomCode.toUpperCase();
  const { gameRoom, createRoom, joinRoom, submitScript, runNextTick } = useGameRoom(cleanRoomCode);
  const tankByPlayer = useMemo(() => new Map(gameRoom?.tanks.map((tank) => [tank.playerId, tank]) ?? []), [gameRoom]);
  const localPlayer = gameRoom?.players.find((player) => player.commanderId === commanderId);
  const ownsClock = localPlayer?.slot === "alpha";
  const roomExists = Boolean(gameRoom?.match);
  const hasJoinedRoom = Boolean(localPlayer);
  const isCreateRoute = searchParams.get("create") === "1";
  const isJoinRoute = searchParams.get("join") === "1";
  const destroyedTank = gameRoom?.tanks.find((tank) => tank.health <= 0);
  const destroyedPlayer = gameRoom?.players.find((player) => player.id === destroyedTank?.playerId);
  const [now, setNow] = useState(Date.now());
  const showGameOver = Boolean(
    destroyedTank && now - (destroyedTank.record.updatedAt ?? now) >= GAME_OVER_DELAY_MS,
  );

  useEffect(() => {
    if (!gameRoom?.match || !ownsClock) {
      return;
    }

    const timer = window.setInterval(() => {
      void runNextTick({ roomCode: cleanRoomCode });
    }, GAME_TICK_MS);

    return () => window.clearInterval(timer);
  }, [cleanRoomCode, gameRoom?.match, ownsClock, runNextTick]);

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
    if (!destroyedTank) {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [destroyedTank]);

  const createBattle = async (event: FormEvent) => {
    event.preventDefault();
    if (!commanderId) {
      return;
    }

    await createRoom({ roomCode: cleanRoomCode, commanderId, battleName });
    navigate(`/battle/${cleanRoomCode}`, { replace: true });
  };

  const submitCommand = async (command: string) => {
    if (command.trim().toLowerCase() === "help") {
      return HELP_TEXT;
    }

    if (!commanderId) {
      throw new Error("Choose a commander before submitting orders");
    }

    await submitScript(commanderId, command);
    if (ownsClock) {
      void runNextTick({ roomCode: cleanRoomCode });
    }
    return describeCommand(command);
  };

  const closeBattleTab = () => {
    window.close();
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
          <BattleBoard gameRoom={gameRoom} />
          {isCreateRoute && !roomExists && (
            <div className="battle-dialog">
              <form className="protocol-panel battle-dialog__panel" onSubmit={createBattle}>
                <p className="eyebrow">Create Battle</p>
                <label className="field">
                  <span>Name</span>
                  <input autoFocus value={battleName} onChange={(event) => setBattleName(event.target.value)} />
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
                <h2>{destroyedPlayer?.name ?? "Tank"} destroyed</h2>
                <button className="button button--primary" type="button" onClick={closeBattleTab}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>

        {hasJoinedRoom && gameRoom?.ready && (
          <BattleConsole commanderName={displayName} roomCode={cleanRoomCode} onCommand={submitCommand} />
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

function statusLabel(status: string | undefined, ready: boolean) {
  if (status === "finished") {
    return "Finished";
  }
  if (ready || status === "active") {
    return "Live";
  }
  return "Waiting";
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
  const [action, rawAmount, rawSecondAmount] = command.trim().toLowerCase().replace(/\s+/g, " ").split(" ");
  const amount = Number(rawAmount);

  if (action === "aim" && Number.isFinite(amount)) {
    const elevation = Number(rawSecondAmount);
    if (Number.isFinite(elevation)) {
      return `Aim ${Math.abs(amount)} degrees ${amount < 0 ? "left" : "right"} at ${elevation} degrees elevation`;
    }
  }

  if (action === "turn" && Number.isFinite(amount)) {
    return `Turn ${Math.abs(amount)} degrees ${amount < 0 ? "left" : "right"}`;
  }

  if ((action === "forward" || action === "backward") && Number.isFinite(amount)) {
    return `${capitalize(action)} ${amount} points`;
  }

  if (action === "fire") {
    const power = Number(rawAmount);
    if (Number.isFinite(power)) {
      return `Fire ${power}% power`;
    }
  }

  if (action === "lock") {
    return "Turret locked";
  }

  if (action === "unlock") {
    return "Turret unlocked";
  }

  if (action === "wait") {
    return "Wait";
  }

  return "Accepted";
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
