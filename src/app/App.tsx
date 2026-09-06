import { Navigate, Route, Routes } from "react-router-dom";
import { CommanderProvider, useCommander } from "./CommanderContext";
import { BattlePage } from "../pages/BattlePage";
import { LobbyPage } from "../pages/LobbyPage";
import { MainLobbyPage } from "../pages/MainLobbyPage";
import { SignInPage } from "../pages/SignInPage";
import { SplashPage } from "../pages/SplashPage";

export default function App() {
  return (
    <CommanderProvider>
      <Routes>
        <Route path="/" element={<SplashPage />} />
        <Route path="/sign-in" element={<SignInPage />} />
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
  const { displayName } = useCommander();

  if (!displayName) {
    return <Navigate to="/sign-in" replace />;
  }

  return children;
}
