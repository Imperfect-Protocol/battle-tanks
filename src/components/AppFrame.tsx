import { Link } from "react-router-dom";
import { useCommander } from "../app/CommanderContext";
import type { ReactNode } from "react";

type AppFrameProps = {
  children: ReactNode;
  eyebrow: string;
  title: string;
};

export function AppFrame({ children, eyebrow, title }: AppFrameProps) {
  const { displayName, signOutCommander } = useCommander();

  return (
    <main className="screen app-screen">
      <header className="app-header">
        <Link className="brand-lockup" to="/">
          <span>BATTLE TANKS</span>
          <strong>Imperfect Protocol</strong>
        </Link>
        <nav className="app-nav" aria-label="Main navigation">
          <Link to="/lobbies">Lobbies</Link>
          <Link to="/leaderboard">Leaderboard</Link>
          <Link to="/settings">Settings</Link>
        </nav>
        <div className="commander-chip">
          <Link to="/sign-in">{displayName}</Link>
          <button type="button" onClick={signOutCommander}>
            Sign Out
          </button>
        </div>
      </header>
      <section className="page-heading">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </section>
      {children}
    </main>
  );
}
