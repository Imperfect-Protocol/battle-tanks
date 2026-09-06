import type { PlayerRecord } from "./types";

export class Player {
  constructor(readonly record: PlayerRecord) {}

  get id() {
    return this.record._id;
  }

  get name() {
    return this.record.name;
  }

  get score() {
    return this.record.score;
  }

  get slot() {
    return this.record.slot;
  }
}
