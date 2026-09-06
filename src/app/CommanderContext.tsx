import { createContext, ReactNode, useContext, useMemo, useState } from "react";

const STORAGE_KEY = "battle-tanks.display-name";

type CommanderContextValue = {
  displayName: string;
  setDisplayName: (name: string) => void;
  clearDisplayName: () => void;
};

const CommanderContext = createContext<CommanderContextValue | null>(null);

export function CommanderProvider({ children }: { children: ReactNode }) {
  const [displayName, setDisplayNameState] = useState(readStoredDisplayName);

  const value = useMemo<CommanderContextValue>(
    () => ({
      displayName,
      setDisplayName: (name) => {
        const nextName = cleanDisplayName(name);
        window.localStorage.setItem(STORAGE_KEY, nextName);
        setDisplayNameState(nextName);
      },
      clearDisplayName: () => {
        window.localStorage.removeItem(STORAGE_KEY);
        setDisplayNameState("");
      },
    }),
    [displayName],
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

function readStoredDisplayName() {
  return cleanDisplayName(window.localStorage.getItem(STORAGE_KEY) ?? "");
}
