import type { Command } from "./Orders";

export abstract class Commander {
  abstract nextCommand(): Command;
}

export class SimpleCommander extends Commander {
  private cursor = 0;

  constructor(private readonly commands: Command[]) {
    super();
  }

  nextCommand(): Command {
    const command = this.commands[this.cursor] ?? "wait";
    this.cursor += 1;
    return command;
  }
}
