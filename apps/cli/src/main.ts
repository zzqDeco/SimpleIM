#!/usr/bin/env bun
import {
  CliSecurityError,
  CliUsageError,
  formatHelpText,
  parseCliArgs,
} from "./args.ts";
import {
  runLoginCommand,
  runLogoutCommand,
  runRegisterCommand,
  runWhoamiCommand,
  type CommandIo,
} from "./commands/auth.ts";
import { runJoinCommand } from "./commands/join.ts";
import { runSeedCommand } from "./commands/seed.ts";

export * from "./index.ts";

export const CLI_VERSION = "0.1.0";

export async function runCli(
  argv: readonly string[],
  io: CommandIo & { abortSignal?: AbortSignal } = {},
): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;

  try {
    const cmd = parseCliArgs(argv);

    switch (cmd.command) {
      case "help":
        stdout.write(`${formatHelpText()}\n`);
        return 0;
      case "version":
        stdout.write(`simpleim ${CLI_VERSION}\n`);
        return 0;
      case "register":
        await runRegisterCommand(cmd, io);
        return 0;
      case "login":
        await runLoginCommand(cmd, io);
        return 0;
      case "logout":
        await runLogoutCommand(cmd, io);
        return 0;
      case "whoami":
        await runWhoamiCommand(cmd, io);
        return 0;
      case "join":
        await runJoinCommand(cmd, io);
        return 0;
      case "seed":
        await runSeedCommand(cmd, io);
        return 0;
    }
  } catch (err) {
    if (err instanceof CliSecurityError) {
      stderr.write(`Security Error: ${err.message}\n`);
      return 2;
    }
    if (err instanceof CliUsageError) {
      stderr.write(`Usage Error: ${err.message}\n`);
      return 2;
    }
    stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}

if (import.meta.main) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exit(exitCode);
}
