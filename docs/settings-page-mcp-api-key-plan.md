# Settings Page And MCP API Key Plan

## Purpose

Create a settings page where a signed-in user can manage their commander setup and create an API key for MCP access. Production must not allow unauthenticated MCP control. An agent should only be able to create battles, join battles, observe privileged state, advance ticks, or issue commands when it presents a valid user-owned API key.

This document is only a plan. Do not implement the page from this file directly without first checking the current codebase state.

## Current App Context

The app already has authenticated users and commander profiles.

- Auth uses Convex Auth.
- Commander profile state comes from `convex/profiles.ts` and `src/app/CommanderContext.tsx`.
- App routing lives in `src/app/App.tsx`.
- Shared page chrome lives in `src/components/AppFrame.tsx`.
- Existing MCP tool registration lives in `convex/mcp.ts`.
- Existing MCP HTTP routing and authorization live in `convex/http.ts`.
- Existing MCP game functions live in `convex/mcpGame.ts`.

Current security issue to address:

- MCP tools are registered with metadata that marks them public.
- The HTTP authorizer currently allows public tools and denies non-public tools.
- Several important MCP tools create or control game state.
- `battle_issue_commands` uses a per-battle `agentKey`, but that key is created by public MCP mutations today.
- Production should require a user API key before an agent can reach any MCP tool.

## Target User Experience

Add a protected settings page available to signed-in users with a commander profile.

Suggested route:

```txt
/settings
```

Suggested navigation:

- Add a `Settings` link to the authenticated app header or main app navigation.
- The existing `BATTLE TANKS` brand behavior should remain unchanged.

The settings page should include three panels:

- Commander panel: list the user's commanders and allow switching the active commander.
- Password panel: provide a `Reset Password` action that uses the existing reset password flow.
- MCP API key panel: let the user create, view metadata for, copy once, and revoke API keys for agent access.

Do not show raw API key values after the creation response. Only show the raw key one time, immediately after generation.

## API Key Behavior

API keys are user-owned credentials for MCP. They are not the same as per-battle `agentKey` values.

Suggested key format:

```txt
bt_mcp_<opaque-secret>
```

Storage requirements:

- Store only a cryptographic hash of the full API key.
- Store a short prefix or suffix for display, such as the first 10 characters and last 4 characters.
- Never store the raw key.
- Redact the raw key from MCP audit logs and error reporting.

Suggested schema table:

```txt
agentApiKeys
```

Suggested fields:

- `userId: Id<"users">`
- `commanderId: Id<"commanderProfiles">`
- `label: string`
- `keyHash: string`
- `keyPreview: string`
- `status: "active" | "revoked"`
- `createdAt: number`
- `lastUsedAt?: number`
- `revokedAt?: number`

Suggested indexes:

- `by_user`
- `by_commander`
- `by_key_hash`
- `by_user_and_status`

Suggested Convex functions:

- `settings.listApiKeys`: authenticated query returning key metadata for the current user.
- `settings.createApiKey`: authenticated mutation that creates one key for the active commander and returns the raw key exactly once.
- `settings.revokeApiKey`: authenticated mutation that revokes a key owned by the current user.

Validation rules:

- The user must be signed in.
- The requested commander must belong to the signed-in user.
- Key labels should be trimmed, length-limited, and optional with a default like `Agent key`.
- Revoked keys cannot authorize MCP.
- API key creation should work even if the user has no previous key.

## MCP Authorization Model

Every MCP request must be authorized before tool execution.

Expected client behavior:

- The agent sends the user API key with each MCP request.
- Preferred transport is an HTTP authorization header:

```txt
Authorization: Bearer bt_mcp_<opaque-secret>
```

Implementation expectations:

- Update the MCP HTTP authorizer in `convex/http.ts` so it reads the bearer token from the request.
- Hash the supplied key and look up `agentApiKeys.by_key_hash`.
- Require `status === "active"`.
- Patch `lastUsedAt` for successful authorization when appropriate.
- Deny the request when the key is missing, malformed, unknown, or revoked.
- Do not rely on tool metadata like `{ public: true }` for production access.
- Do not allow unauthenticated public MCP tools in production.

The authorizer should make the authenticated API key owner available to tool execution if the gateway supports contextual auth data. If the gateway cannot pass custom auth context directly, use a documented fallback pattern supported by `convex-mcp-gateway`.

Required authorization data for MCP game functions:

- `userId`
- `commanderId`
- API key document id or hash preview for audit/debugging

## MCP Game Function Changes

Update MCP game functions so the user API key controls identity and permissions.

Expected behavior:

- `battle_list_lobbies` requires a valid API key.
- `battle_list_games` requires a valid API key.
- `battle_create_game` creates a player owned by the API key's `userId` and `commanderId`.
- `battle_join_game` creates a player owned by the API key's `userId` and `commanderId`.
- `battle_issue_commands` requires both:
  - valid user API key for MCP access, and
  - valid per-battle `agentKey` for controlling the specific player in that battle.
- `battle_advance_tick` requires valid user API key; when an `agentKey` is also supplied, it must match a player in the battle.
- `battle_observe` requires valid user API key. If it exposes own-tank-only details, those details must be limited to the player controlled by the provided `agentKey`.
- `battle_recent_collisions` requires valid user API key.

The per-battle `agentKey` remains useful because it scopes control to one tank in one battle. The user API key is the outer gate that proves the caller is allowed to use MCP at all.

Do not let an API key for one commander control another commander's player.

## Settings Page Details

Suggested page component:

```txt
src/pages/SettingsPage.tsx
```

Suggested route:

```tsx
<Route
  path="/settings"
  element={
    <RequireCommander>
      <SettingsPage />
    </RequireCommander>
  }
/>
```

Commander panel:

- Use `useCommander()` to list `commanders`.
- Show active commander.
- Let the user switch active commander through the existing `setActiveCommanderId` context method.
- If the app already has a commander selection/editing screen, link to that instead of duplicating complex commander editing.

Password panel:

- Provide a `Reset Password` button or link.
- Route to the existing `/reset-password` path or invoke the existing Convex Auth reset flow used by `SignInPage`.
- Do not invent a second password reset system.

MCP API key panel:

- List active and revoked keys owned by the user.
- Show label, preview, created date, last used date, and status.
- Provide `Create key`.
- Provide `Revoke` for active keys.
- After creating a key, display the raw key once with a copy button.
- Warn in plain UI copy that the key cannot be viewed again after leaving the screen.
- Never render any other user's keys.

## Acceptance Criteria

- Signed-in users with a commander can open `/settings`.
- Signed-out users or users without a commander are redirected through the existing auth/commander flow.
- The page lists the user's commanders and can switch the active commander.
- The page exposes the existing password reset path.
- The page can create an MCP API key for the active commander.
- The raw API key is shown exactly once after creation.
- Only key metadata is shown after creation.
- A key can be revoked.
- Revoked keys cannot authorize MCP requests.
- Missing API keys cannot authorize MCP requests.
- Invalid API keys cannot authorize MCP requests.
- No MCP tool is publicly accessible in production.
- MCP-created and MCP-joined players are associated with the API key owner's `userId` and `commanderId`.
- An API key cannot control another user's commander or battle player.
- Existing browser gameplay remains authenticated through the current Convex Auth flow.

## Suggested Tests

- Test API key creation requires an authenticated user.
- Test API key creation rejects a commander owned by another user.
- Test raw key is returned on creation and never from list queries.
- Test revoke requires key ownership.
- Test a revoked key fails MCP authorization.
- Test missing bearer token fails MCP authorization.
- Test malformed bearer token fails MCP authorization.
- Test valid bearer token allows MCP access.
- Test MCP-created players include `userId` and `commanderId`.
- Test one commander's API key cannot issue commands for another commander's player.
- Run type checking after implementation.

## Non-Goals

- Do not add OAuth client management for third-party agents.
- Do not build organization/team key sharing.
- Do not expose raw API keys after initial creation.
- Do not remove per-battle `agentKey` scoping unless a separate design replaces it.
- Do not make any MCP tool public in production.
