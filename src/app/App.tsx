import { useConvexAuth } from "@convex-dev/auth/react";
import { Navigate, Route, Routes } from "react-router-dom";
import { CommanderProvider, useCommander } from "./CommanderContext";
import { BattlePage } from "../pages/BattlePage";
import { LobbyPage } from "../pages/LobbyPage";
import { MainLobbyPage } from "../pages/MainLobbyPage";
import { PlaceholderPage } from "../pages/PlaceholderPage";
import { SignInPage } from "../pages/SignInPage";
import { SplashPage } from "../pages/SplashPage";

export default function App() {
  return (
    <CommanderProvider>
      <Routes>
        <Route path="/" element={<SplashPage />} />
        <Route path="/sign-in" element={<SignInPage />} />
        <Route path="/reset-password" element={<SignInPage />} />
        <Route
          path="/lobbies"
          element={
            <RequireCommander>
              <MainLobbyPage />
            </RequireCommander>
          }
        />
        <Route
          path="/lobbies/pvp"
          element={
            <RequireCommander>
              <LobbyPage />
            </RequireCommander>
          }
        />
        <Route
          path="/leaderboard"
          element={
            <RequireCommander>
              <PlaceholderPage eyebrow="Leaderboard" title="Leaderboard" />
            </RequireCommander>
          }
        />
        <Route
          path="/settings"
          element={
            <RequireCommander>
              <PlaceholderPage eyebrow="Settings" title="Settings" />
            </RequireCommander>
          }
        />
        <Route
          path="/battle/:roomCode"
          element={
            <RequireCommander>
              <BattlePage />
            </RequireCommander>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </CommanderProvider>
  );
}

function RequireCommander({ children }: { children: JSX.Element }) {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { hasCommander, isLoadingProfile } = useCommander();

  if (isLoading || (isAuthenticated && isLoadingProfile)) {
    return <AuthLoading />;
  }

  if (!isAuthenticated || !hasCommander) {
    return <Navigate to="/sign-in" replace />;
  }

  return children;
}

function AuthLoading() {
  return (
    <main className="screen centered-screen">
      <div className="protocol-panel auth-panel">
        <p className="eyebrow">Connecting</p>
        <h1>Authorizing</h1>
      </div>
    </main>
  );
}
