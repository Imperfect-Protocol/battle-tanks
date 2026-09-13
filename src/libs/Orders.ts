import { normalizeOrderCommand } from "../../convex/gameCore";

export type Command =
  | `bear ${number}`
  | `move ${number}`
  | `aim ${number}`
  | `elev ${number}`
  | `pow ${number}`
  | "fire"
  | "ret";

export class Orders {
  constructor(readonly commands: Command[], readonly invalidCommands: string[] = []) {}

  get isEmpty() {
    return this.commands.length === 0;
  }

  get hasInvalidCommands() {
    return this.invalidCommands.length > 0;
  }

  static parse(script: string) {
    const commands: Command[] = [];
    const invalidCommands: string[] = [];

    for (const command of script.split(/[\n,;]+/)) {
      const normalized = command.trim();
      if (!normalized) {
        continue;
      }

      const parsed = normalizeOrderCommand(normalized) as Command[];
      if (parsed.length === 0) {
        invalidCommands.push(normalized);
        continue;
      }

      commands.push(...parsed);
    }

    return new Orders(commands, invalidCommands);
  }
}
