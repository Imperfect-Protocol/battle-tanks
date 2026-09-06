import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { useNavigate } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { cleanDisplayName, useCommander } from "../app/CommanderContext";

export function SignInPage() {
  const navigate = useNavigate();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn } = useAuthActions();
  const {
    commanders,
    commanderId,
    suggestedDisplayName,
    isLoadingProfile,
    setActiveCommanderId,
    signOutCommander,
  } = useCommander();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [nameError, setNameError] = useState("");
  const cleanedName = cleanDisplayName(name);
  const claimDisplayName = useMutation(api.profiles.claimDisplayName);
  const isNameTakenByOtherAccount = useQuery(
    api.profiles.isDisplayNameTaken,
    cleanedName ? { displayName: cleanedName } : "skip",
  );
  const isNameTakenByThisAccount = commanders.some((commander) => commander.displayName === cleanedName);
  const showNameTaken = Boolean(cleanedName && (isNameTakenByOtherAccount || isNameTakenByThisAccount));

  useEffect(() => {
    if (!name && suggestedDisplayName) {
      setName(suggestedDisplayName);
    }
  }, [name, suggestedDisplayName]);

  useEffect(() => {
    if (!showNameTaken) {
      setNameError("");
    }
  }, [showNameTaken]);

  const signInWithGitHub = () => {
    setAuthError("");
    void signIn("github", { redirectTo: "/sign-in" }).catch(() => {
      setAuthError("OAuth sign-in could not start");
    });
  };

  const submitPassword = (flow: "signIn" | "signUp") => {
    setAuthError("");
    void signIn("password", { flow, email, password })
      .then(() => {
        setPassword("");
      })
      .catch((error) => {
        setAuthError(error instanceof Error ? error.message : "Password authentication failed");
      });
  };

  const selectCommander = (nextCommanderId: Id<"commanderProfiles">) => {
    setActiveCommanderId(nextCommanderId);
    navigate("/lobbies");
  };

  const submitName = (event: FormEvent) => {
    event.preventDefault();
    if (!cleanedName) {
      return;
    }
    if (showNameTaken) {
      setNameError("Name already taken");
      return;
    }

    setNameError("");
    void claimDisplayName({ displayName: cleanedName })
      .then((commander) => {
        setActiveCommanderId(commander.commanderId);
        navigate("/lobbies");
      })
      .catch((error) => {
        setNameError(error instanceof Error ? error.message : "Commander could not be created");
      });
  };

  if (isLoading || (isAuthenticated && isLoadingProfile)) {
    return (
      <main className="screen centered-screen">
        <section className="protocol-panel sign-in-panel auth-panel">
          <p className="eyebrow">OAuth</p>
          <h1>Authorizing</h1>
        </section>
      </main>
    );
  }

  if (!isAuthenticated) {
    return (
      <main className="screen centered-screen">
        <section className="protocol-panel sign-in-panel auth-panel">
          <p className="eyebrow">OAuth Required</p>
          <h1>Sign In</h1>
          <p className="panel-copy">Connect with GitHub, or use email and password before entering the public battle network.</p>
          <button className="button button--primary" type="button" onClick={signInWithGitHub}>
            Continue with GitHub
          </button>
          <div className="auth-divider">or</div>
          <label className="field">
            <span>Email</span>
            <input
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="commander@example.com"
              type="email"
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="8+ characters"
              type="password"
            />
          </label>
          <div className="auth-actions">
            <button
              className="button button--primary"
              disabled={!email || !password}
              type="button"
              onClick={() => submitPassword("signIn")}
            >
              Sign In
            </button>
            <button
              className="button button--ghost"
              disabled={!email || !password}
              type="button"
              onClick={() => submitPassword("signUp")}
            >
              Create Account
            </button>
          </div>
          {authError ? <p className="field-error">{authError}</p> : null}
        </section>
      </main>
    );
  }

  return (
    <main className="screen centered-screen">
      <form className="protocol-panel sign-in-panel" onSubmit={submitName}>
        <p className="eyebrow">Commander Access</p>
        <h1>{commanders.length > 0 ? "Choose Commander" : "Create Commander"}</h1>
        {commanders.length > 0 ? (
          <div className="commander-select-list">
            {commanders.map((commander) => (
              <button
                className={`commander-select ${commander.id === commanderId ? "commander-select--active" : ""}`}
                key={commander.id}
                type="button"
                onClick={() => selectCommander(commander.id)}
              >
                <span>{commander.displayName}</span>
                <strong>{commander.id === commanderId ? "Active" : "Select"}</strong>
              </button>
            ))}
          </div>
        ) : null}
        <label className="field">
          <span>New Commander</span>
          <input
            autoFocus={commanders.length === 0}
            aria-invalid={showNameTaken || Boolean(nameError)}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="COMMANDER"
          />
          {showNameTaken ? <p className="field-error">Name already taken</p> : null}
          {!showNameTaken && nameError ? <p className="field-error">{nameError}</p> : null}
        </label>
        <button className="button button--primary" disabled={!cleanedName || showNameTaken} type="submit">
          Create Commander
        </button>
        <button className="button button--ghost" type="button" onClick={signOutCommander}>
          Sign Out
        </button>
      </form>
    </main>
  );
}
