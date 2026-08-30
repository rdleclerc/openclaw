import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerMessageReadEditDeleteCommands } from "./register.read-edit-delete.js";

describe("registerMessageReadEditDeleteCommands", () => {
  it("registers complete only for read", async () => {
    const runMessageAction = vi.fn(
      async (_action: string, _opts: Record<string, unknown>) => undefined,
    );
    const message = new Command().exitOverride();
    const addTarget = (command: Command) => command.option("-t, --target <dest>", "Target");
    registerMessageReadEditDeleteCommands(message, {
      withMessageBase: (command) => command.option("--channel <channel>", "Channel"),
      withMessageTarget: addTarget,
      withRequiredMessageTarget: addTarget,
      runMessageAction,
    });
    const optionNames = (name: string) =>
      message.commands
        .find((command) => command.name() === name)
        ?.options.map((option) => option.long);

    expect(optionNames("read")).toContain("--complete");
    for (const name of ["edit", "delete"]) expect(optionNames(name)).not.toContain("--complete");
    await message.parseAsync(["read", "--channel", "slack", "-t", "C1", "--complete"], {
      from: "user",
    });
    expect(runMessageAction).toHaveBeenCalledWith(
      "read",
      expect.objectContaining({ complete: true }),
    );
  });
});
