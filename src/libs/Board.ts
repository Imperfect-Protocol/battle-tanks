import { Vector } from "./Vector";
import type { BoardRecord } from "./types";

export class Board {
  readonly walls: Vector[];
  readonly spawnPoints: Vector[];

  constructor(readonly record: BoardRecord) {
    this.walls = record.walls.map(Vector.fromRecord);
    this.spawnPoints = record.spawnPoints.map(Vector.fromRecord);
  }

  get id() {
    return this.record._id;
  }

  get size() {
    return this.record.size;
  }

  contains(position: Vector) {
    return position.x >= 0 && position.y >= 0 && position.x < this.size && position.y < this.size;
  }

  isWall(position: Vector) {
    return this.walls.some((wall) => wall.equals(position));
  }
}
