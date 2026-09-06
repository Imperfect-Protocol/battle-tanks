import { useEffect, useState } from "react";
import { useConvexAuth } from "@convex-dev/auth/react";
import { useNavigate } from "react-router-dom";
import { useCommander } from "../app/CommanderContext";

const SPLASH_VISIBLE_MS = 1600;
const SPLASH_FADE_MS = 650;

export function SplashPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { hasCommander, isLoadingProfile } = useCommander();
  const [isFading, setIsFading] = useState(false);
  const [readyToLeave, setReadyToLeave] = useState(false);

  useEffect(() => {
    const fadeTimer = window.setTimeout(() => setIsFading(true), SPLASH_VISIBLE_MS);
    const navigateTimer = window.setTimeout(() => setReadyToLeave(true), SPLASH_VISIBLE_MS + SPLASH_FADE_MS);

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(navigateTimer);
    };
  }, []);

  useEffect(() => {
    if (!readyToLeave || isLoading || (isAuthenticated && isLoadingProfile)) {
      return;
    }

    navigate(isAuthenticated && hasCommander ? "/lobbies" : "/sign-in");
  }, [hasCommander, isAuthenticated, isLoading, isLoadingProfile, navigate, readyToLeave]);

  return (
    <main className={`screen splash-screen ${isFading ? "splash-screen--fade" : ""}`}>
      <div className="splash-mark">
        <h1>BATTLE TANKS</h1>
        <div className="splash-rule" />
        <p>Imperfect Protocol</p>
      </div>
    </main>
  );
}
