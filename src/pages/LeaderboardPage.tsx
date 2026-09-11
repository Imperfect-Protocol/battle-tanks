import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { AppFrame } from "../components/AppFrame";
import { TankAvatar } from "../components/TankAvatar";
import type { TankSpecRecord } from "../libs/types";

type LeaderboardEntry = {
  commanderId: Id<"commanderProfiles">;
  displayName: string;
  tankSpec?: TankSpecRecord;
  wins: number;
  losses: number;
  draws: number;
  battles: number;
};

export function LeaderboardPage() {
  const entries = useQuery(api.game.getLeaderboard) as LeaderboardEntry[] | undefined;

  return (
    <AppFrame eyebrow="Leaderboard" title="Top Commanders">
      <section className="protocol-panel leaderboard-panel" aria-label="Leaderboard">
        <header className="panel-heading">
          <div>
            <h2>Combat Record</h2>
            <p className="leaderboard-panel__copy">Top 10 ranked by victories</p>
          </div>
        </header>
        <div className="battle-table-wrap custom-scrollbar">
          <table className="battle-table leaderboard-table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Commander</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Draws</th>
                <th>Battles</th>
              </tr>
            </thead>
            <tbody>
              {entries === undefined && (
                <tr>
                  <td colSpan={6} className="empty-row">Scanning records</td>
                </tr>
              )}
              {entries?.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-row">No battle records</td>
                </tr>
              )}
              {entries?.map((entry, index) => (
                <tr key={entry.commanderId}>
                  <td><strong className={`leaderboard-rank leaderboard-rank--${index + 1}`}>#{index + 1}</strong></td>
                  <td>
                    <div className="leaderboard-commander">
                      <TankAvatar label={entry.displayName} spec={entry.tankSpec} />
                      <strong>{entry.displayName}</strong>
                    </div>
                  </td>
                  <td className="leaderboard-value leaderboard-value--win">{entry.wins}</td>
                  <td className="leaderboard-value leaderboard-value--loss">{entry.losses}</td>
                  <td className="leaderboard-value">{entry.draws}</td>
                  <td className="leaderboard-value">{entry.battles}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </AppFrame>
  );
}
