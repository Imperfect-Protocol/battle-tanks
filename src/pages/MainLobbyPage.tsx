import { Link } from "react-router-dom";
import { AppFrame } from "../components/AppFrame";

export function MainLobbyPage() {
  return (
    <AppFrame eyebrow="Main Lobby" title="Choose Lobby">
      <section className="lobby-grid">
        <Link className="lobby-card" to="/lobbies/pvp">
          <div>
            <h2>PvP</h2>
            <p>Battle</p>
          </div>
          <span>Open</span>
        </Link>
      </section>
    </AppFrame>
  );
}
