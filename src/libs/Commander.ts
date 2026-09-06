import type { Command } from "./Orders";

export abstract class Commander {
  abstract nextCommand(): Command | null;
}

export class SimpleCommander extends Commander {
  private cursor = 0;

  constructor(private readonly commands: Command[]) {
    super();
  }

  nextCommand(): Command | null {
    const command = this.commands[this.cursor] ?? null;
    this.cursor += 1;
    return command;
  }
}
