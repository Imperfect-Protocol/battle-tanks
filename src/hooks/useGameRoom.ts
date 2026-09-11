import { useMutation, useQuery } from "convex/react";
import { useCallback } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { GameRoom } from "../libs/GameRoom";
import { Orders } from "../libs/Orders";

export function useGameRoom(roomCode: string, commanderId?: Id<"commanderProfiles"> | "") {
  const room = useQuery(api.game.getRoom, {
    roomCode,
    ...(commanderId ? { commanderId } : {}),
  });
  const createRoom = useMutation(api.game.createRoom);
  const joinRoom = useMutation(api.game.joinRoom);
  const runPlayerTick = useMutation(api.game.runPlayerTick);
  const tickPlayer = useCallback((commanderId: Id<"commanderProfiles">, observedEvents: unknown[] = []) =>
    (runPlayerTick as (args: unknown) => Promise<null>)({
      roomCode,
      commanderId,
      commands: [],
      observedEvents,
    }), [roomCode, runPlayerTick]);
  const submitScript = useCallback((commanderId: Id<"commanderProfiles">, script: string, observedEvents: unknown[] = []) => {
    const orders = Orders.parse(script);
    if (orders.isEmpty || orders.hasInvalidCommands) {
      throw new Error("Incorrect command");
    }

    return (runPlayerTick as (args: unknown) => Promise<null>)({
      roomCode,
      commanderId,
      commands: splitCommands(script),
      observedEvents,
    });
  }, [roomCode, runPlayerTick]);

  return {
    gameRoom: room
      ? new GameRoom(
          room.match,
          room.board,
          room.players,
          room.tanks,
          room.projectiles,
          room.orders,
          room.events,
          Boolean(room.ownPendingWork),
        )
      : null,
    createRoom,
    joinRoom,
    tickPlayer,
    submitScript,
  };
}

function splitCommands(script: string) {
  return script
    .split(/[\n,;]+/)
    .map((command) => command.trim())
    .filter(Boolean);
}
