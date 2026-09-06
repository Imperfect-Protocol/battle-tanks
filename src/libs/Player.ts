import type { PlayerRecord } from "./types";

export class Player {
  constructor(readonly record: PlayerRecord) {}

  get id() {
    return this.record._id;
  }

  get userId() {
    return this.record.userId;
  }

  get commanderId() {
    return this.record.commanderId;
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
