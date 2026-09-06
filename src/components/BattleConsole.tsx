import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";

type ConsoleMessage = {
  kind: "system" | "command";
  text: string;
  level?: "info" | "error";
};

type BattleConsoleProps = {
  commanderName: string;
  roomCode: string;
  onCommand: (command: string) => Promise<string | void>;
};

export function BattleConsole({ commanderName, roomCode, onCommand }: BattleConsoleProps) {
  const [input, setInput] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [messages, setMessages] = useState<ConsoleMessage[]>([
    { kind: "system", text: "LINK ESTABLISHED", level: "info" },
  ]);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const shouldAutoScrollRef = useRef(true);

  useEffect(() => {
    const messageList = messageListRef.current;
    if (!messageList || !shouldAutoScrollRef.current) {
      return;
    }

    messageList.scrollTop = messageList.scrollHeight;
  }, [messages.length]);

  const submitCommand = async (event: FormEvent) => {
    event.preventDefault();
    const command = input.trim();
    if (!command) {
      return;
    }

    setInput("");
    setCommandHistory((current) => [...current, command]);
    setHistoryCursor(null);
    setMessages((current) => [...current, { kind: "command", text: command }]);

    try {
      const response = await onCommand(command);
      setMessages((current) => [...current, { kind: "system", text: response ?? "Accepted", level: "info" }]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        { kind: "system", text: error instanceof Error ? error.message : "Incorrect command", level: "error" },
      ]);
    }
  };

  const recallCommand = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
      return;
    }

    if (commandHistory.length === 0) {
      return;
    }

    event.preventDefault();

    if (event.key === "ArrowUp") {
      const nextCursor = historyCursor === null ? commandHistory.length - 1 : Math.max(0, historyCursor - 1);
      setHistoryCursor(nextCursor);
      setInput(commandHistory[nextCursor]);
      return;
    }

    if (historyCursor === null) {
      return;
    }

    const nextCursor = historyCursor + 1;
    if (nextCursor >= commandHistory.length) {
      setHistoryCursor(null);
      setInput("");
      return;
    }

    setHistoryCursor(nextCursor);
    setInput(commandHistory[nextCursor]);
  };

  return (
    <section className="battle-console" aria-label="Battle console">
      <header className="battle-console__header">
        <span>{commanderName}</span>
        <span>{roomCode}</span>
      </header>
      <div
        ref={messageListRef}
        className="battle-console__history custom-scrollbar"
        onScroll={() => {
          const messageList = messageListRef.current;
          if (!messageList) {
            return;
          }
          const distanceFromBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight;
          shouldAutoScrollRef.current = distanceFromBottom < 12;
        }}
      >
        {messages.map((message, index) => (
          <div
            key={`${message.kind}-${index}`}
            className={`battle-console__line battle-console__line--${message.kind} ${
              message.level === "error" ? "battle-console__line--error" : ""
            }`}
          >
            {message.kind === "command" ? `> ${message.text}` : message.text}
          </div>
        ))}
      </div>
      <form className="battle-console__form" onSubmit={(event) => void submitCommand(event)}>
        <input
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={recallCommand}
          placeholder="COMMAND..."
        />
      </form>
    </section>
  );
}
