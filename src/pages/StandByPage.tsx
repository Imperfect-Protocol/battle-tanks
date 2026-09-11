import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { allowTabCloseWithoutPrompt, closeCurrentTab } from "../libs/browserTab";

const CLOSE_AFTER_MS = 10 * 60 * 1000;

export function StandByPage() {
  const navigate = useNavigate();
  const { roomCode = "" } = useParams();
  const [startedAt] = useState(Date.now);
  const [now, setNow] = useState(Date.now);
  const remainingMs = Math.max(0, CLOSE_AFTER_MS - (now - startedAt));

  useEffect(() => allowTabCloseWithoutPrompt(), []);

  useEffect(() => {
    if (remainingMs <= 0) {
      closeCurrentTab();
      window.setTimeout(() => {
        if (!window.closed) {
          navigate("/lobbies/pvp", { replace: true });
        }
      }, 120);
      return;
    }

    const timer = window.setTimeout(() => setNow(Date.now()), 1000);
    return () => window.clearTimeout(timer);
  }, [navigate, remainingMs]);

  return (
    <main className="screen centered-screen standby-screen">
      <section className="protocol-panel standby-panel">
        <p className="eyebrow">Idle Link</p>
        <h1>Stand By</h1>
        <div className="standby-clock">{formatCountdown(remainingMs)}</div>
        <button className="button button--primary" type="button" onClick={() => navigate(`/battle/${roomCode}`)}>
          Return to The Battle
        </button>
      </section>
    </main>
  );
}

function formatCountdown(milliseconds: number) {
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
