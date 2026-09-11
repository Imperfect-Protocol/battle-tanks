import { useEffect, useRef, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { BattleSimulation } from "../libs/BattleSimulation";
import type { GameRoom } from "../libs/GameRoom";

const SIMULATION_FRAME_MS = 40;

export function useBattleSimulation(
  room: GameRoom | null,
  roomCode: string,
  commanderId?: Id<"commanderProfiles"> | null,
) {
  const simulationRef = useRef(new BattleSimulation());
  const checkpointBattleState = useMutation(api.game.checkpointBattleState);
  const checkpointInFlightRef = useRef<Promise<unknown> | null>(null);
  const [simulatedRoom, setSimulatedRoom] = useState<GameRoom | null>(null);
  const localPlayerId = room?.players.find((player) => player.commanderId === commanderId)?.id ?? null;

  useEffect(() => {
    if (!room) {
      setSimulatedRoom(null);
      return;
    }

    let frameId = 0;
    let lastRenderedAt = 0;
    const flushCheckpoints = () => {
      if (!commanderId || checkpointInFlightRef.current) {
        return;
      }

      const checkpoints = simulationRef.current.consumeCheckpoints();
      if (checkpoints.length === 0) {
        return;
      }

      const completedClientCommandIds = Array.from(new Set(checkpoints.flatMap((checkpoint) => checkpoint.completedClientCommandIds)));
      const nextCommands = uniqueNextCommands(checkpoints.flatMap((checkpoint) => checkpoint.nextCommands));
      const tankStates = uniqueLatestTankStates(checkpoints.flatMap((checkpoint) => checkpoint.tanks));
      const finished = checkpoints.find((checkpoint) => checkpoint.finished)?.finished;
      const checkpoint = (checkpointBattleState as (args: unknown) => Promise<null>)({
        roomCode,
        commanderId,
        completedCommandIds: [],
        completedClientCommandIds,
        nextCommands,
        tanks: tankStates.map((tank) => ({
          tankId: tank._id,
          position: tank.position,
          velocity: tank.velocity,
          speed: tank.speed,
          moveRemaining: tank.moveRemaining,
          activeMoveCommand: tank.activeMoveCommand,
          hullDirection: typeof tank.hullDirection === "number" ? tank.hullDirection : 0,
          turretDirection: typeof tank.turretDirection === "number" ? tank.turretDirection : 0,
          turretLocked: tank.turretLocked,
          launchAngle: tank.launchAngle,
          cannonPower: tank.cannonPower,
          lastFirePower: tank.lastFirePower,
          health: tank.health,
          updatedAt: tank.updatedAt,
        })),
        ...(finished ? { finished } : {}),
      });
      checkpointInFlightRef.current = checkpoint;
      void checkpoint.finally(() => {
        if (checkpointInFlightRef.current === checkpoint) {
          checkpointInFlightRef.current = null;
        }
      });
    };
    const tick = (time: number) => {
      if (time - lastRenderedAt >= SIMULATION_FRAME_MS) {
        lastRenderedAt = time;
        setSimulatedRoom(simulationRef.current.sync(room, Date.now(), localPlayerId));
        flushCheckpoints();
      }
      frameId = window.requestAnimationFrame(tick);
    };

    setSimulatedRoom(simulationRef.current.sync(room, Date.now(), localPlayerId));
    flushCheckpoints();
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [checkpointBattleState, commanderId, localPlayerId, room, roomCode]);

  return {
    gameRoom: simulatedRoom,
    queueCommands: (commands: string[]) => simulationRef.current.queueLocalCommands(localPlayerId, commands),
  };
}

function uniqueLatestTankStates(tanks: GameRoom["tanks"][number]["record"][]) {
  const byId = new Map<string, GameRoom["tanks"][number]["record"]>();
  for (const tank of tanks) {
    const previous = byId.get(tank._id);
    if (!previous || tank.updatedAt >= previous.updatedAt) {
      byId.set(tank._id, tank);
    }
  }
  return [...byId.values()];
}

function uniqueNextCommands(commands: Array<{ clientCommandId: string; queueType: "move" | "bearing" | "cannon"; command: string }>) {
  const byId = new Map<string, { clientCommandId: string; queueType: "move" | "bearing" | "cannon"; command: string }>();
  for (const command of commands) {
    byId.set(command.clientCommandId, command);
  }
  return [...byId.values()];
}
