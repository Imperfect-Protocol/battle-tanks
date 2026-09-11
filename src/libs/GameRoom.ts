import { Board } from "./Board";
import { Missile } from "./Missile";
import { Player } from "./Player";
import { Tank } from "./Tank";
import type { BoardRecord, OrderRecord, PlayerRecord, ProjectileRecord, TankRecord, WorldEventRecord } from "./types";

export class GameRoom {
  readonly board: Board | null;
  readonly players: Player[];
  readonly tanks: Tank[];
  readonly projectiles: Missile[];
  readonly events: WorldEventRecord[];

  constructor(
    readonly match: {
      roomCode: string;
      status: string;
      currentTick: number;
      winnerPlayerId?: string;
      finishedAt?: number;
      updatedAt?: number;
    } | null,
    board: BoardRecord | null,
    players: PlayerRecord[],
    tanks: TankRecord[],
    projectiles: ProjectileRecord[],
    readonly orders: OrderRecord[],
    events: WorldEventRecord[] = [],
    readonly ownPendingWork = false,
  ) {
    this.board = board ? new Board(board) : null;
    this.players = players.map((player) => new Player(player));
    this.tanks = tanks.map((tank) => new Tank(tank));
    this.projectiles = projectiles
      .filter((projectile) => projectile.status === "active" || projectile.status === "exploding")
      .map((projectile) => new Missile(projectile));
    this.events = events;
  }

  get ready() {
    return this.players.length >= 2;
  }
}
