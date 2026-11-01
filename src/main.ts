import { homedir } from "node:os"
import { isAbsolute } from "node:path"
import { Effect } from "effect"
import { options } from "./cli.ts"
import { components } from "./components/index.ts"
import { logComponent, runComponents } from "./runner.ts"
import { liveSystem } from "./system.ts"
import { zshStartupDirectory } from "./zsh.ts"

async function main() {
  const settings = options(process.argv.slice(2))
  const { mode, profile, json } = settings
  if (process.platform !== "darwin") throw new Error("This configurator supports macOS only.")
  if (process.getuid?.() === 0) throw new Error("Run as your normal user, without sudo.")
  const mise = process.env.BOOTSTRAP_MISE_BIN
  const brew = process.env.BOOTSTRAP_BREW_BIN
  if (!mise || !isAbsolute(mise) || !brew || !isAbsolute(brew)) throw new Error("Run through bootstrap.sh so Homebrew, mise, and Node.js are prepared.")
  const system = liveSystem(process.env, { interactiveOutput: json ? "stderr" : "inherit" })
  const zshDirectory = await Effect.runPromise(zshStartupDirectory(system))
  const machine = { home: homedir(), zshDirectory, profile, brew, mise }
  if (json) console.log(JSON.stringify({ type: "start", version: 1, profile, mode }))
  else console.log(`Profile: ${profile}; mode: ${mode}`)
  const states = await Effect.runPromise(runComponents(components(system, machine), {
    ...settings,
    onEvent: event => json ? console.log(JSON.stringify(event)) : logComponent(event, mode, console.log)
  }))
  const success = states.every(state => state.status !== "error" && state.status !== "blocked")
  if (!success) process.exitCode = 1
  if (json) console.log(JSON.stringify({ type: "complete", success, components: states }))
  else if (!success) console.error("Some components need attention; rerun with --component <id> to retry one.")
  else if (mode === "preview") console.log("Preview only: configuration was not applied.")
  else if (mode === "plan") console.log("Plan only: machine settings were inspected, without applying changes.")
  else console.log("Configuration applied. Open a new login terminal to pick up Homebrew and mise.")
}

main().catch(error => {
  const message = error instanceof Error ? error.message : String(error)
  if (process.argv.includes("--json")) console.log(JSON.stringify({ type: "fatal", message }))
  console.error(`Error: ${message}`)
  process.exitCode = 1
})
