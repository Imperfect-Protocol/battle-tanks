import { useQuery } from "convex/react";
import { Link } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import { AppFrame } from "../components/AppFrame";
import { useCommander } from "../app/CommanderContext";
import type { Id } from "../../convex/_generated/dataModel";

type BattleRow = {
  _id: Id<"matches">;
  roomCode: string;
  battleName?: string;
  status: "lobby" | "active";
  playerCount: number;
  maxPlayers: number;
  updatedAt: number;
  viewerIsPlayer: boolean;
};

export function LobbyPage() {
  const { commanderId } = useCommander();
  const battles = useQuery(api.game.listBattles, {
    lobbyId: "pvp",
    ...(commanderId ? { commanderId } : {}),
  }) as BattleRow[] | undefined;
  const liveBattles = battles?.filter((battle) => battle.status === "active") ?? [];
  const openBattles = battles?.filter((battle) => battle.status === "lobby") ?? [];

  return (
    <AppFrame eyebrow="PvP Lobby" title="Battles">
      <section className="protocol-panel battle-list-panel">
        <header className="panel-heading">
          <h2>Battle</h2>
          <Link className="button button--primary" target="_blank" rel="noopener noreferrer" to="/battle/new?create=1">
            Create Battle
          </Link>
        </header>
        {battles === undefined ? (
          <div className="empty-row">Scanning</div>
        ) : (
          <>
            <BattleTable title="Live Battles" battles={liveBattles} />
            <BattleTable title="Open Battles" battles={openBattles} />
          </>
        )}
      </section>
    </AppFrame>
  );
}

function BattleTable({ title, battles }: { title: string; battles: BattleRow[] }) {
  return (
    <section className="battle-table-section">
      <h3>{title}</h3>
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
            {battles.length === 0 && (
              <tr>
                <td colSpan={5} className="empty-row">
                  No battles
                </td>
              </tr>
            )}
            {battles.map((battle) => (
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
                  <Link className="button button--compact" target="_blank" rel="noopener noreferrer" to={battleActionPath(battle)}>
                    {battleActionLabel(battle)}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function statusLabel(status: BattleRow["status"]) {
  if (status === "active") {
    return "Live";
  }
  return "Waiting";
}

function battleActionLabel(battle: BattleRow) {
  if (battle.viewerIsPlayer) {
    return "Return";
  }
  return battle.status === "active" ? "Watch" : "Join";
}

function battleActionPath(battle: BattleRow) {
  if (battle.viewerIsPlayer || battle.status === "active") {
    return `/battle/${battle.roomCode}`;
  }
  return `/battle/${battle.roomCode}?join=1`;
}

function formatUpdatedAt(updatedAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  }).format(updatedAt);
}
