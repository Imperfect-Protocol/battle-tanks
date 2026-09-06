import { useQuery } from "convex/react";
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { AppFrame } from "../components/AppFrame";

type BattleRow = {
  roomCode: string;
  battleName?: string;
  status: "lobby" | "active" | "finished";
  playerCount: number;
  maxPlayers: number;
  updatedAt: number;
};

export function LobbyPage() {
  const battles = useQuery(api.game.listBattles, { lobbyId: "pvp" }) as BattleRow[] | undefined;
  const newBattleRoomCode = useMemo(createRoomCode, []);

  return (
    <AppFrame eyebrow="PvP Lobby" title="Battles">
      <section className="protocol-panel battle-list-panel">
        <header className="panel-heading">
          <h2>Battle</h2>
          <Link className="button button--primary" target="_blank" rel="noopener noreferrer" to={`/battle/${newBattleRoomCode}?create=1`}>
            Create Battle
          </Link>
        </header>
        <div className="battle-table-wrap custom-scrollbar">
          <table className="battle-table">
            <thead>
              <tr>
                <th>Session</th>
                <th>Players</th>
                <th>Status</th>
                <th>Updated</th>
                <th>
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {battles === undefined && (
                <tr>
                  <td colSpan={5} className="empty-row">
                    Scanning
                  </td>
                </tr>
              )}
              {battles?.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-row">
                    No battles
                  </td>
                </tr>
              )}
              {battles?.map((battle) => (
                <tr key={battle.roomCode}>
                  <td>
                    <strong>{battle.battleName ?? "Battle"}</strong>
                    <span>{battle.roomCode}</span>
                  </td>
                  <td>
                    {battle.playerCount}/{battle.maxPlayers}
                  </td>
                  <td>
                    <span className={`state-badge state-badge--${battle.status}`}>{statusLabel(battle.status)}</span>
                  </td>
                  <td>{formatUpdatedAt(battle.updatedAt)}</td>
                  <td>
                    <Link className="button button--compact" target="_blank" rel="noopener noreferrer" to={`/battle/${battle.roomCode}?join=1`}>
                      Join
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppFrame>
  );
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = new Uint8Array(6);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

function statusLabel(status: BattleRow["status"]) {
  if (status === "active") {
    return "Live";
  }
  if (status === "finished") {
    return "Finished";
  }
  return "Waiting";
}

function formatUpdatedAt(updatedAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(updatedAt);
}
