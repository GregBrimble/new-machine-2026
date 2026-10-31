import { spawn } from "node:child_process"
import { closeSync, constants, openSync } from "node:fs"
import { access, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect } from "effect"

export class BootstrapError extends Error {
  readonly _tag = "BootstrapError"
  readonly operation: string
  constructor(operation: string, cause: unknown) {
    super(`${operation}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    this.operation = operation
  }
}
export interface Command { file: string; args: ReadonlyArray<string>; input?: string; interactive?: boolean }
export interface CommandResult { code: number; stdout: string; stderr: string }
export interface System {
  homebrewCandidates: ReadonlyArray<string>
  run(command: Command): Effect.Effect<CommandResult, BootstrapError>
  executable(path: string): Effect.Effect<boolean, BootstrapError>
  readText(path: string): Effect.Effect<string | undefined, BootstrapError>
  writeText(path: string, text: string): Effect.Effect<void, BootstrapError>
  mkdir(path: string): Effect.Effect<void, BootstrapError>
  realpath(path: string): Effect.Effect<string, BootstrapError>
}

const io = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, BootstrapError> =>
  Effect.tryPromise({ try: run, catch: cause => new BootstrapError(operation, cause) })

export function liveSystem(env: NodeJS.ProcessEnv): System {
  return {
    homebrewCandidates: [
      ...(env.BOOTSTRAP_BREW_BIN ? [env.BOOTSTRAP_BREW_BIN] : []),
      ...(env.PATH ?? "").split(":").filter(Boolean).map(path => `${path}/brew`),
      "/opt/homebrew/bin/brew", "/usr/local/bin/brew"
    ],
    run: command => Effect.tryPromise({
      try: signal => new Promise<CommandResult>((resolve, reject) => {
        let terminal: number | undefined
        if (command.interactive) {
          try { terminal = openSync("/dev/tty", "r") } catch { /* Headless installers use inherited stdin. */ }
        }
        const release = () => {
          if (terminal !== undefined) { closeSync(terminal); terminal = undefined }
        }
        try {
          const child = spawn(command.file, [...command.args], {
            env, signal,
            stdio: command.interactive
              ? [terminal ?? "inherit", "inherit", "inherit"]
              : [command.input === undefined ? "ignore" : "pipe", "pipe", "pipe"]
          })
          let stdout = "", stderr = ""
          child.stdout?.setEncoding("utf8").on("data", chunk => { stdout += chunk })
          child.stderr?.setEncoding("utf8").on("data", chunk => { stderr += chunk })
          child.once("error", error => { release(); reject(error) })
          child.once("close", (code, killedBy) => {
            release()
            if (code === null) reject(new Error(`Process ended with signal ${killedBy}`))
            else resolve({ code, stdout, stderr })
          })
          child.stdin?.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") reject(error) })
          if (command.input !== undefined) child.stdin?.end(command.input)
        } catch (error) { release(); reject(error) }
      }),
      catch: cause => new BootstrapError(command.file, cause)
    }),
    executable: path => io(`Check executable ${path}`, async () => {
      try { await access(path, constants.X_OK); return (await stat(path)).isFile() }
      catch (error) {
        if (["ENOENT", "ENOTDIR", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return false
        throw error
      }
    }),
    readText: path => io(`Read ${path}`, async () => {
      try { return await readFile(path, "utf8") }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error }
    }),
    writeText: (path, text) => io(`Write ${path}`, async () => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, text)
    }),
    mkdir: path => io(`Create ${path}`, async () => { await mkdir(path, { recursive: true }) }),
    realpath: path => io(`Resolve ${path}`, () => realpath(path))
  }
}

export function checked(system: System, command: Command): Effect.Effect<string, BootstrapError> {
  return Effect.gen(function* () {
    const result = yield* system.run(command)
    if (result.code !== 0) return yield* Effect.fail(new BootstrapError(
      command.file,
      result.stderr.trim() || `Exited with status ${result.code}`
    ))
    return result.stdout.trim()
  })
}
