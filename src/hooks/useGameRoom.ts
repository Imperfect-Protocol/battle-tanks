import { useMutation, useQuery } from "convex/react";
import { useCallback, useMemo } from "react";
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
  const sendCommands = useMutation(api.game.sendCommands);
  const submitScript = useCallback((commanderId: Id<"commanderProfiles">, script: string) => {
    const orders = Orders.parse(script);
    if (orders.isEmpty || orders.hasInvalidCommands) {
      throw new Error("Incorrect command");
    }

    return (sendCommands as (args: unknown) => Promise<null>)({
      roomCode,
      commanderId,
      commands: splitCommands(script),
    });
  }, [roomCode, sendCommands]);
  const gameRoom = useMemo(
    () =>
      room
        ? new GameRoom(
            room.match,
            room.board,
            room.players,
            room.tanks,
            room.projectiles,
            room.orders,
            room.events,
            room.commandBatches ?? [],
            room.commandTimelines ?? [],
            Boolean(room.ownPendingWork),
          )
        : null,
    [room],
  );

  return {
    gameRoom,
    createRoom,
    joinRoom,
    submitScript,
  };
}

function splitCommands(script: string) {
  return script
    .split(/[\n,;]+/)
    .map((command) => command.trim())
    .filter(Boolean);
}
