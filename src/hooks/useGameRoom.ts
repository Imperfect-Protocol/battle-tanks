import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { GameRoom } from "../libs/GameRoom";
import { Orders } from "../libs/Orders";

export function useGameRoom(roomCode: string) {
  const room = useQuery(api.game.getRoom, { roomCode });
  const createRoom = useMutation(api.game.createRoom);
  const joinRoom = useMutation(api.game.joinRoom);
  const submitOrders = useMutation(api.game.submitOrders);
  const runNextTick = useMutation(api.game.runNextTick);

  return {
    gameRoom: room
      ? new GameRoom(
          room.match,
          room.board,
          room.players,
          room.tanks,
          room.projectiles,
          room.orders,
        )
      : null,
    createRoom,
    joinRoom,
    runNextTick,
    submitScript: (playerName: string, script: string) =>
      submitOrders({
        roomCode,
        playerName,
        commands: Orders.parse(script).commands,
      }),
  };
}
