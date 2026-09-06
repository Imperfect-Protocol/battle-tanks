import { FormEvent, useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { cleanDisplayName, useCommander } from "../app/CommanderContext";
import { TankAvatar } from "../components/TankAvatar";

type AuthMode = "signIn" | "forgot" | "reset";

export function SignInPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { isAuthenticated, isLoading } = useConvexAuth();
  const { signIn } = useAuthActions();
  const {
    commanders,
    commanderId,
    isLoadingProfile,
    setActiveCommanderId,
    signOutCommander,
  } = useCommander();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [resetCode, setResetCode] = useState(searchParams.get("code") ?? "");
  const [authMode, setAuthMode] = useState<AuthMode>(location.pathname === "/reset-password" ? "reset" : "signIn");
  const [authError, setAuthError] = useState("");
  const [authNotice, setAuthNotice] = useState("");
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
    if (!showNameTaken) {
      setNameError("");
    }
  }, [showNameTaken]);

  useEffect(() => {
    if (location.pathname !== "/reset-password") {
      return;
    }

    const emailFromUrl = searchParams.get("email") ?? "";
    const codeFromUrl = searchParams.get("code") ?? "";
    setAuthMode("reset");
    if (emailFromUrl) {
      setEmail(emailFromUrl);
    }
    if (codeFromUrl) {
      setResetCode(codeFromUrl);
    }
  }, [location.pathname, searchParams]);

  const showAuthError = (error: unknown) => {
    console.error(error);
    setAuthError(formatAuthError(error));
  };

  const signInWithGitHub = () => {
    setAuthError("");
    setAuthNotice("");
    void signIn("github", { redirectTo: "/sign-in" }).catch(showAuthError);
  };

  const submitPassword = (flow: "signIn" | "signUp") => {
    setAuthError("");
    setAuthNotice("");
    void signIn("password", { flow, email, password })
      .then(() => {
        setPassword("");
      })
      .catch(showAuthError);
  };

  const requestPasswordReset = (event: FormEvent) => {
    event.preventDefault();
    setAuthError("");
    setAuthNotice("");
    void signIn("password", {
      flow: "reset",
      email,
      redirectTo: `/reset-password?email=${encodeURIComponent(email)}`,
    })
      .then(() => {
        setAuthMode("reset");
        setAuthNotice("Reset link sent. Check your email.");
      })
      .catch(showAuthError);
  };

  const submitPasswordReset = (event: FormEvent) => {
    event.preventDefault();
    setAuthError("");
    setAuthNotice("");
    void signIn("password", {
      flow: "reset-verification",
      email,
      code: resetCode,
      newPassword,
    })
      .then(() => {
        setNewPassword("");
        setResetCode("");
        setAuthNotice("Password reset complete.");
      })
      .catch(showAuthError);
  };

  const showSignIn = () => {
    setAuthMode("signIn");
    setAuthError("");
    setAuthNotice("");
    if (location.pathname === "/reset-password") {
      navigate("/sign-in", { replace: true });
    }
  };

  const showForgotPassword = () => {
    setAuthMode("forgot");
    setAuthError("");
    setAuthNotice("");
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
          {authMode === "signIn" ? (
            <>
              <p className="eyebrow">Account Required</p>
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
              <div className="auth-link-row">
                <button className="button-link" type="button" onClick={showForgotPassword}>
                  Forgot password
                </button>
              </div>
            </>
          ) : null}
          {authMode === "forgot" ? (
            <form className="auth-form" onSubmit={requestPasswordReset}>
              <p className="eyebrow">Password Recovery</p>
              <h1>Forgot Password</h1>
              <p className="panel-copy">Enter your email and we will send a reset link.</p>
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
              <button className="button button--primary" disabled={!email} type="submit">
                Send Reset Link
              </button>
              <button className="button button--ghost" type="button" onClick={showSignIn}>
                Back
              </button>
            </form>
          ) : null}
          {authMode === "reset" ? (
            <form className="auth-form" onSubmit={submitPasswordReset}>
              <p className="eyebrow">Password Recovery</p>
              <h1>Reset Password</h1>
              <p className="panel-copy">Paste the reset code from your email link and choose a new password.</p>
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
                <span>Reset Code</span>
                <input
                  autoComplete="one-time-code"
                  value={resetCode}
                  onChange={(event) => setResetCode(event.target.value)}
                  placeholder="CODE"
                />
              </label>
              <label className="field">
                <span>New Password</span>
                <input
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  placeholder="8+ characters"
                  type="password"
                />
              </label>
              <button className="button button--primary" disabled={!email || !resetCode || !newPassword} type="submit">
                Reset Password
              </button>
              <button className="button button--ghost" type="button" onClick={showSignIn}>
                Back
              </button>
            </form>
          ) : null}
          {authNotice ? <p className="auth-notice">{authNotice}</p> : null}
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
        <div className="commander-select-panel custom-scrollbar">
          {commanders.length > 0 ? (
            commanders.map((commander) => (
              <button
                className={`commander-select ${commander.id === commanderId ? "commander-select--active" : ""}`}
                key={commander.id}
                type="button"
                onClick={() => selectCommander(commander.id)}
              >
                <span className="commander-select__identity">
                  <TankAvatar label={commander.displayName} spec={commander.tankSpec} />
                  <span>{commander.displayName}</span>
                </span>
                <strong>{commander.id === commanderId ? "Active" : "Select"}</strong>
              </button>
            ))
          ) : (
            <div className="commander-empty">No commanders</div>
          )}
        </div>
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

function formatAuthError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("InvalidSecret") || message.includes("Invalid credentials")) {
    return "Invalid Password";
  }
  if (/Account .+ already exists/.test(message)) {
    return "Account already exists. Sign in instead.";
  }
  if (message.includes("InvalidAccountId")) {
    return "No password account found for that email.";
  }
  if (message.includes("TooManyFailedAttempts")) {
    return "Too many attempts. Try again later.";
  }
  if (message.includes("Invalid code") || message.includes("Could not verify code")) {
    return "Invalid or expired reset link.";
  }
  if (message.includes("Invalid password")) {
    return "Password must be at least 8 characters.";
  }
  if (message.includes("Could not send password reset email")) {
    return "Could not send reset email. Try again.";
  }
  if (message.includes("Password reset is not enabled")) {
    return "Password reset is not configured yet.";
  }
  if (message.includes("OAuth sign-in could not start") || message.includes("invalid_client")) {
    return "GitHub sign-in is not configured yet.";
  }
  if (message.includes("Failed to fetch") || message.includes("NetworkError")) {
    return "Could not reach the auth server. Try again.";
  }

  return "Authentication failed. Try again.";
}
