import { createContext, ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { useQuery } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const ACTIVE_COMMANDER_STORAGE_KEY = "battle-tanks.active-commander-id";

type CommanderContextValue = {
  displayName: string;
  userId: string | null;
  commanderId: Id<"commanderProfiles"> | null;
  commanders: CommanderSummary[];
  suggestedDisplayName: string;
  hasCommander: boolean;
  isLoadingProfile: boolean;
  setActiveCommanderId: (commanderId: Id<"commanderProfiles">) => void;
  signOutCommander: () => void;
};

const CommanderContext = createContext<CommanderContextValue | null>(null);

export function CommanderProvider({ children }: { children: ReactNode }) {
  const viewer = useQuery(api.profiles.getViewer) as CommanderViewer | null | undefined;
  const { signOut } = useAuthActions();
  const [activeCommanderId, setActiveCommanderIdState] = useState<Id<"commanderProfiles"> | "">(
    readActiveCommanderId,
  );
  const commanders = viewer?.commanders ?? [];
  const activeCommander =
    commanders.find((commander) => commander.id === activeCommanderId) ?? commanders[0] ?? null;

  useEffect(() => {
    if (viewer === undefined) {
      return;
    }

    const nextCommanderId = activeCommander?.id ?? "";
    if (nextCommanderId === activeCommanderId) {
      return;
    }

    setActiveCommanderIdState(nextCommanderId);
    writeActiveCommanderId(nextCommanderId);
  }, [activeCommander?.id, activeCommanderId, viewer]);

  const value = useMemo<CommanderContextValue>(
    () => ({
      displayName: activeCommander?.displayName ?? "",
      userId: viewer?.userId ?? null,
      commanderId: activeCommander?.id ?? null,
      commanders,
      suggestedDisplayName: viewer?.suggestedDisplayName ?? "",
      hasCommander: Boolean(activeCommander),
      isLoadingProfile: viewer === undefined,
      setActiveCommanderId: (commanderId) => {
        setActiveCommanderIdState(commanderId);
        writeActiveCommanderId(commanderId);
      },
      signOutCommander: () => {
        writeActiveCommanderId("");
        setActiveCommanderIdState("");
        void signOut();
      },
    }),
    [activeCommander, commanders, signOut, viewer],
  );

  return <CommanderContext.Provider value={value}>{children}</CommanderContext.Provider>;
}

export function useCommander() {
  const value = useContext(CommanderContext);
  if (!value) {
    throw new Error("useCommander must be used inside CommanderProvider");
  }
  return value;
}

export function cleanDisplayName(name: string) {
  return name.trim().slice(0, 32);
}

type CommanderSummary = {
  id: Id<"commanderProfiles">;
  displayName: string;
};

type CommanderViewer = {
  userId: string;
  commanders: CommanderSummary[];
  suggestedDisplayName: string;
};

function readActiveCommanderId() {
  return (window.localStorage.getItem(ACTIVE_COMMANDER_STORAGE_KEY) ?? "") as Id<"commanderProfiles"> | "";
}

function writeActiveCommanderId(commanderId: Id<"commanderProfiles"> | "") {
  if (commanderId) {
    window.localStorage.setItem(ACTIVE_COMMANDER_STORAGE_KEY, commanderId);
    return;
  }

  window.localStorage.removeItem(ACTIVE_COMMANDER_STORAGE_KEY);
}
