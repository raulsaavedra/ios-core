import type { Command } from "./types";

export interface RunOptions {
  cwd?: string;
  environment?: Record<string, string>;
  input?: string;
  quiet?: boolean;
}

export interface CommandRunner {
  run(command: Command, options?: RunOptions): Promise<void>;
  capture(command: Command, options?: RunOptions): Promise<string>;
  succeeds(command: Command, options?: RunOptions): boolean;
}

function commandText(command: Command): string {
  return command.map((part) => JSON.stringify(part)).join(" ");
}

export const systemRunner: CommandRunner = {
  async run(command, options = {}) {
    const subprocess = Bun.spawn([...command], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.environment },
      stdin: new Blob([options.input ?? ""]),
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await subprocess.exited;
    if (exitCode !== 0) throw new Error(`${commandText(command)} exited with code ${exitCode}.`);
  },

  async capture(command, options = {}) {
    const subprocess = Bun.spawn([...command], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: { ...process.env, ...options.environment },
      stdin: new Blob([options.input ?? ""]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      subprocess.exited,
      new Response(subprocess.stdout).text(),
      new Response(subprocess.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `${commandText(command)} exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : "."}`,
      );
    }
    return stdout.trim();
  },

  succeeds(command, options = {}) {
    return (
      Bun.spawnSync([...command], {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: { ...process.env, ...options.environment },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }).exitCode === 0
    );
  },
};
