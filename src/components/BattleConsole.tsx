import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import {
  AiCommandConsolePresenter,
  AiConsoleMetaCommandParser,
  type AiAssistResult,
  type IntentFileSummary,
} from "../libs/AiCommandConsole";
import type { Tank } from "../libs/Tank";

type ConsoleMessage = {
  kind: "system" | "command";
  prompt?: string;
  text: string;
  level?: "info" | "error";
};

type BattleConsoleProps = {
  commanderName: string;
  commanderId?: Id<"commanderProfiles"> | null;
  roomCode: string;
  tank: Tank | null;
  onCommand: (command: string) => Promise<string | void>;
};

const aiConsolePresenter = new AiCommandConsolePresenter();
const aiConsoleMetaCommandParser = new AiConsoleMetaCommandParser();

export function BattleConsole({ commanderName, commanderId, roomCode, tank, onCommand }: BattleConsoleProps) {
  const [input, setInput] = useState("");
  const [commandHistory, setCommandHistory] = useState<string[]>([]);
  const [historyCursor, setHistoryCursor] = useState<number | null>(null);
  const [aiMode, setAiMode] = useState(false);
  const [selectedIntentFileId, setSelectedIntentFileId] = useState<Id<"intentFiles"> | null>(null);
  const [sessionAiModel, setSessionAiModel] = useState<string | null>(null);
  const [intentMenuOpen, setIntentMenuOpen] = useState(false);
  const [messages, setMessages] = useState<ConsoleMessage[]>([
    { kind: "system", text: "LINK ESTABLISHED", level: "info" },
  ]);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const intentFiles = useQuery(
    api.aiCommander.listIntentFiles,
    commanderId ? { commanderId } : "skip",
  ) as IntentFileSummary[] | undefined;
  const saveIntentFile = useMutation(api.aiCommander.saveIntentFile);
  const assist = useAction(api.aiCommanderActions.assist);
  const selectedIntentFile =
    intentFiles?.find((file) => file.id === selectedIntentFileId) ?? intentFiles?.[0] ?? null;
  const prompt = aiConsolePresenter.formatPrompt(tank);

  useEffect(() => {
    if (!selectedIntentFileId && intentFiles?.[0]) {
      setSelectedIntentFileId(intentFiles[0].id);
    }
  }, [intentFiles, selectedIntentFileId]);

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

    try {
      const metaCommand = aiConsoleMetaCommandParser.parse(command);
      setMessages((current) => [
        ...current,
        {
          kind: "command",
          prompt,
          text: metaCommand ? command : `${aiMode ? "AI " : ""}${command}`,
        },
      ]);
      const response = metaCommand ? await submitMetaCommand(metaCommand) : aiMode ? await submitAiCommand(command) : await onCommand(command);
      setMessages((current) => [...current, { kind: "system", text: response ?? "Accepted", level: "info" }]);
    } catch (error) {
      setMessages((current) => [
        ...current,
        { kind: "system", text: error instanceof Error ? error.message : "Incorrect command", level: "error" },
      ]);
    }
  };

  const submitMetaCommand = async (command: ReturnType<AiConsoleMetaCommandParser["parse"]>) => {
    if (!command) {
      return;
    }
    if (!commanderId) {
      throw new Error("Choose a commander before configuring AI");
    }
    if (command.action === "useModel") {
      setSessionAiModel(command.model);
      return `Using ${command.model} model.`;
    }
  };

  const submitAiCommand = async (intent: string) => {
    if (!commanderId) {
      throw new Error("Choose a commander before using AI");
    }
    const intentFile = selectedIntentFile;
    if (!intentFile) {
      fileInputRef.current?.click();
      throw new Error("Upload an intent file first");
    }

    setMessages((current) => [...current, { kind: "system", text: "AI thinking...", level: "info" }]);
    const result = await (assist as (args: unknown) => Promise<AiAssistResult>)({
      roomCode,
      commanderId,
      intentFileId: intentFile.id,
      intent,
      ...(sessionAiModel ? { model: sessionAiModel } : {}),
    });
    console.info("[Battle Tanks AI]", {
      input: result.debugInput ?? {
        intent,
        model: sessionAiModel ?? "default",
        intentFile: intentFile.filename,
      },
      output: {
        provider: result.provider,
        model: result.model,
        configured: result.configured,
        latencyMs: result.latencyMs,
        commandLine: result.commandLine,
        commands: result.commands,
      },
    });
    setMessages((current) => [
      ...current,
      { kind: "system", text: `AI: ${result.commandLine}`, level: "info" },
      { kind: "system", text: aiConsolePresenter.formatMetrics(result), level: result.configured ? "info" : "error" },
    ]);
    await onCommand(result.commandLine);
    return "Accepted";
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

  const toggleAiMode = () => {
    if (aiMode) {
      setAiMode(false);
      return;
    }
    if (!selectedIntentFile) {
      fileInputRef.current?.click();
      return;
    }
    setAiMode(true);
  };

  const uploadIntentFile = async (file: File) => {
    if (!commanderId) {
      throw new Error("Choose a commander before uploading intent files");
    }

    const content = await file.text();
    const saved = await saveIntentFile({ commanderId, filename: file.name, content });
    setSelectedIntentFileId(saved.id);
    setAiMode(true);
    setMessages((current) => [
      ...current,
      { kind: "system", text: `Intent file loaded: ${saved.filename}`, level: "info" },
    ]);
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
            {message.kind === "command" ? `${message.prompt ?? ""}> ${message.text}` : message.text}
          </div>
        ))}
      </div>
      <form className="battle-console__form" onSubmit={(event) => void submitCommand(event)}>
        <div className="battle-console__input-row">
          <span className="battle-console__prompt">{prompt}&gt;</span>
          <input
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={recallCommand}
            placeholder={aiMode ? "INTENT..." : "COMMAND..."}
          />
          <div className="ai-command-control">
            <button
              className={`ai-command-control__toggle ${aiMode ? "ai-command-control__toggle--active" : ""}`}
              type="button"
              onClick={toggleAiMode}
              title={selectedIntentFile ? `AI mode: ${selectedIntentFile.filename}` : "Upload intent file"}
            >
              AI
            </button>
            <button
              className="ai-command-control__menu-button"
              type="button"
              aria-label="Choose intent file"
              onClick={() => setIntentMenuOpen((open) => !open)}
            >
              <span aria-hidden="true" />
            </button>
            {intentMenuOpen && (
              <div className="ai-command-control__menu">
                {(intentFiles ?? []).map((file) => (
                  <button
                    key={file.id}
                    type="button"
                    onClick={() => {
                      setSelectedIntentFileId(file.id);
                      setAiMode(true);
                      setIntentMenuOpen(false);
                    }}
                  >
                    <span>{file.filename}</span>
                    <small>{aiConsolePresenter.formatBytes(file.size)}</small>
                  </button>
                ))}
                {intentFiles?.length === 0 && <div className="ai-command-control__empty">No intent files</div>}
                <button
                  type="button"
                  onClick={() => {
                    setIntentMenuOpen(false);
                    fileInputRef.current?.click();
                  }}
                >
                  <span>Upload intent file</span>
                </button>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            className="battle-console__file-input"
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) {
                return;
              }
              void uploadIntentFile(file).catch((error) => {
                setMessages((current) => [
                  ...current,
                  { kind: "system", text: error instanceof Error ? error.message : "Intent upload failed", level: "error" },
                ]);
              });
            }}
          />
        </div>
      </form>
    </section>
  );
}
