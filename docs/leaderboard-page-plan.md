# Leaderboard Page Plan

## Purpose

Create a leaderboard page that ranks commanders by finished battle results. The page should help a player answer:

- Who has won the most battles?
- Who has the best winning rate?
- Who is strongest overall when both volume and win rate are considered?

This document is only a plan. Do not implement the page from this file directly without first checking the current codebase state.

## Current App Context

The app is a Convex-backed React game.

- Frontend routing lives in `src/app/App.tsx`.
- Authenticated app pages use `src/components/AppFrame.tsx`.
- Logged-in commander state comes from `src/app/CommanderContext.tsx`.
- Battle records are stored in Convex tables declared in `convex/schema.ts`.
- Finished battle state is represented on `matches` by `status: "finished"`, `winnerPlayerId`, and `finishedAt`.
- Battle participants are stored in `players`, linked by `matchId`.
- Human players can be linked to `userId` and `commanderId`.
- Existing MCP-created players may only have `agentKeyHash`. After the Settings/MCP API key work, MCP-created players should also be linked to the owning `userId` and active `commanderId` so those battles count toward the owner's leaderboard record.

## Target User Experience

Add a protected leaderboard page available to signed-in users with a commander profile.

Suggested route:

```txt
/leaderboard
```

Suggested navigation:

- Add a `Leaderboard` link to the authenticated app header or main app navigation.
- Keep existing `BATTLE TANKS` brand behavior unchanged.
- Keep the page visually consistent with lobby pages that use `AppFrame`.

Suggested page title:

```txt
Leaderboard
```

Suggested table columns:

- `Rank`
- `Commander`
- `Total Battles`
- `Battles Won`
- `Battles Lost`
- `Winning Rate`
- `Won Rank`
- `Rate Rank`
- `Score`

The exact column names can be adjusted for visual fit, but the page must include total battles, wins, losses, winning rate, and enough ranking detail to explain why a commander has their overall rank.

## Ranking Model

For each leaderboard row:

```txt
totalBattles = battlesWon + battlesLost
winningRate = totalBattles === 0 ? 0 : battlesWon / totalBattles
```

Compute two independent ranks:

```txt
placeWon = rank by battlesWon descending
placeRate = rank by winningRate descending
```

Then compute the composite score:

```txt
leaderboardScore = (k * placeWon + m * placeRate) / (k + m)
```

Lower `leaderboardScore` is better because place numbers are ranks.

Default weights:

```txt
k = 2
m = 1
```

This default gives more weight to proven battle volume while still rewarding a high winning rate. Keep these weights as constants near the leaderboard query or in a small shared leaderboard helper so they are easy to tune later.

Recommended tie handling:

- Use competition ranking for `placeWon` and `placeRate`: equal metric values receive the same place, and the next place skips ahead.
- For final ordering, sort by `leaderboardScore` ascending.
- Break equal composite scores by `battlesWon` descending.
- Then break ties by `winningRate` descending.
- Then break ties by `totalBattles` descending.
- Then break ties by display name ascending.

Recommended minimum battle behavior:

- Include all commanders with at least one finished battle.
- Do not hide low-sample commanders in the first version.
- Optionally add a small visual marker later for commanders with fewer than a configured minimum, but do not change their math silently.

## Convex Data Requirements

Add a Convex query that returns leaderboard rows. Suggested file:

```txt
convex/leaderboard.ts
```

Suggested query name:

```txt
list
```

Suggested query arguments:

- `lobbyId?: string`, defaulting to `"pvp"`.
- `limit?: number`, clamped to a reasonable range such as `1..100`, defaulting to `50`.

Suggested return shape:

```ts
{
  commanderId?: Id<"commanderProfiles">;
  displayName: string;
  totalBattles: number;
  battlesWon: number;
  battlesLost: number;
  winningRate: number;
  placeWon: number;
  placeRate: number;
  leaderboardScore: number;
}
```

The query should count only finished matches. A match is eligible when:

- `match.status === "finished"`, or existing runtime logic would resolve it as finished.
- The match has a `winnerPlayerId`.
- The match belongs to the requested lobby when a lobby is provided.

For each eligible match:

- Load players by `matchId`.
- For each player in the match, group the result by stable identity.
- A win is counted for the player whose `_id` equals `match.winnerPlayerId`.
- A loss is counted for every other player in that finished match.

Identity grouping rules:

- Prefer `player.commanderId` when present.
- Load `commanderProfiles` for commander display names.
- If legacy or AI-only records do not have `commanderId`, group by a documented fallback key such as normalized `player.name`.
- Once the Settings/MCP API key plan is implemented, MCP-created players should be written with `userId` and `commanderId`, so new agent battles naturally contribute to the owning commander.

Indexes and performance:

- The current `matches` table has indexes by lobby and created/status fields, but no direct `finishedAt` leaderboard index.
- For the first version, it is acceptable to scan a bounded recent set of matches for the selected lobby, then compute the leaderboard in the query.
- If the number of finished matches grows, add either:
  - a `matches` index optimized for finished matches by lobby/status/finishedAt, or
  - a derived stats table such as `commanderBattleStats` updated when a match finishes.
- Do not compute leaderboard stats on the client from all raw matches.

## Frontend Requirements

Add a React page component. Suggested file:

```txt
src/pages/LeaderboardPage.tsx
```

Expected behavior:

- Use `useQuery(api.leaderboard.list, { lobbyId: "pvp" })`.
- Render loading state while the query is undefined.
- Render an empty state when there are no finished battles.
- Render a stable table layout for leaderboard rows.
- Format `winningRate` as a percentage, for example `67%` or `66.7%`.
- Format `leaderboardScore` with one or two decimals.
- Highlight the current active commander when their `commanderId` matches `useCommander().commanderId`.
- Keep the page authenticated through the same `RequireCommander` wrapper as lobby and battle pages.

Recommended route registration:

```tsx
<Route
  path="/leaderboard"
  element={
    <RequireCommander>
      <LeaderboardPage />
    </RequireCommander>
  }
/>
```

## Acceptance Criteria

- Signed-in users with a commander can open `/leaderboard`.
- Signed-out users or users without a commander are redirected through the existing auth/commander flow.
- The page shows total battles, wins, losses, winning rate, won rank, rate rank, composite score, and final rank.
- Rankings are deterministic and match the formula in this document.
- Finished matches with a winner affect the leaderboard.
- Active or lobby matches do not affect the leaderboard.
- MCP-created battles count toward a commander when their players have `commanderId`.
- Legacy players without `commanderId` do not crash the query.
- The UI has loading and empty states.
- The app type-checks after implementation.

## Suggested Tests

- Unit-test the ranking helper if the math is extracted to a pure function.
- Test ties for wins, winning rate, and final composite score.
- Test zero/empty results.
- Test a player with one win and no losses.
- Test a player with mixed wins/losses.
- Test legacy player rows without `commanderId`.
- Add a Convex test for the query if the project has Convex test infrastructure available.

## Non-Goals

- Do not build season filters in the first version.
- Do not add public profile pages.
- Do not add pagination until the data size requires it.
- Do not retroactively backfill old AI-only players unless a migration is explicitly requested.
