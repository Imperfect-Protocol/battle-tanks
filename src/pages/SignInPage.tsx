import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { cleanDisplayName, useCommander } from "../app/CommanderContext";

export function SignInPage() {
  const navigate = useNavigate();
  const { displayName, setDisplayName } = useCommander();
  const [name, setName] = useState(displayName);

  const submitName = (event: FormEvent) => {
    event.preventDefault();
    const nextName = cleanDisplayName(name);
    if (!nextName) {
      return;
    }

    setDisplayName(nextName);
    navigate("/lobbies");
  };

  return (
    <main className="screen centered-screen">
      <form className="protocol-panel sign-in-panel" onSubmit={submitName}>
        <p className="eyebrow">Sign In</p>
        <h1>Commander Name</h1>
        <label className="field">
          <span>Display Name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="COMMANDER"
          />
        </label>
        <button className="button button--primary" type="submit">
          Continue
        </button>
      </form>
    </main>
  );
}
