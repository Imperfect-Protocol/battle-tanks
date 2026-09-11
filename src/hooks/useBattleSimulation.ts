import { useEffect, useRef, useState } from "react";
import { BattleSimulation } from "../libs/BattleSimulation";
import type { GameRoom } from "../libs/GameRoom";

const SIMULATION_FRAME_MS = 40;

export function useBattleSimulation(room: GameRoom | null) {
  const simulationRef = useRef(new BattleSimulation());
  const [simulatedRoom, setSimulatedRoom] = useState<GameRoom | null>(null);

  useEffect(() => {
    if (!room) {
      setSimulatedRoom(null);
      return;
    }

    let frameId = 0;
    let lastRenderedAt = 0;
    const tick = (time: number) => {
      if (time - lastRenderedAt >= SIMULATION_FRAME_MS) {
        lastRenderedAt = time;
        setSimulatedRoom(simulationRef.current.sync(room, Date.now()));
      }
      frameId = window.requestAnimationFrame(tick);
    };

    setSimulatedRoom(simulationRef.current.sync(room, Date.now()));
    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [room]);

  return simulatedRoom;
}
