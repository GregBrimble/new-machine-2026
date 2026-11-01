import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { homebrewBundle, homebrew, settings } from "../src/components/homebrew.ts"
import { runComponents } from "../src/runner.ts"
import type { Command } from "../src/system.ts"
import { fakeSystem, machine, result } from "./helpers.ts"

function fixture() {
  const config = settings(machine()), installed = new Set<string>(), commands: Command[] = []
  const state = { checkFailure: false, installFailure: false, ineffective: false }
  const system = fakeSystem({ run: command => Effect.sync(() => {
    commands.push(command)
    assert.equal(command.file, "/brew")
    assert.deepEqual(command.args.slice(2), ["--no-upgrade", "--file=-"])
    const desired = [...config.formulae.map(name => `brew "${name}"\n`), ...config.casks.map(name => `cask "${name}"\n`)].join("")
    assert.equal(command.input, desired)
    if (command.args[1] === "check") return state.checkFailure ? result("", 2, "Bundle check failed")
      : result("", [...config.formulae, ...config.casks].every(name => installed.has(name)) ? 0 : 1)
    assert.equal(command.args[1], "install"); assert.equal(command.interactive, true)
    if (state.installFailure) return result("", 1, "Package installation failed")
    if (!state.ineffective) for (const name of [...config.formulae, ...config.casks]) installed.add(name)
    return result()
  }) })
  const run = () => Effect.runPromise(runComponents([homebrewBundle(system, config, "/brew")], { mode: "apply", failFast: true }))
  return { config, installed, commands, state, run }
}

test("Bundle installs missing packages, preserves unrelated ones, and converges", async () => {
  const f = fixture(); f.installed.add("ghostty"); f.installed.add("another-tool")
  await f.run()
  assert.deepEqual(f.commands.map(command => command.args[1]), ["check", "install", "check"])
  assert.ok([...f.config.formulae, ...f.config.casks, "another-tool"].every(name => f.installed.has(name)))
  f.commands.length = 0
  await f.run(); assert.deepEqual(f.commands.map(command => command.args[1]), ["check"])
})

for (const field of ["formulae", "casks", "both"] as const) {
  test(`Bundle handles empty ${field} lists`, async () => {
    const f = fixture()
    if (field !== "casks") f.config.formulae = []
    if (field !== "formulae") f.config.casks = []
    await f.run()
    assert.equal(f.commands.some(command => command.args[1] === "install"), field !== "both")
  })
}

for (const failure of ["checkFailure", "installFailure", "ineffective"] as const) {
  test(`Bundle surfaces ${failure}`, async () => {
    const f = fixture(); f.state[failure] = true
    await assert.rejects(f.run())
    if (failure === "checkFailure") assert.equal(f.commands.length, 1)
  })
}

test("missing Homebrew directs repair through the launcher", async () => {
  const system = fakeSystem({ executable: () => Effect.succeed(false) })
  await assert.rejects(Effect.runPromise(runComponents([homebrew(system, "/brew")], { mode: "apply", failFast: true })), /bootstrap.sh/u)
})

for (const field of ["formulae", "casks"] as const) {
  test(`${field} names must be safe in a Brewfile`, () => {
    for (const name of ['ghostty"\nsystem "unexpected"', "#{1 + 1}", "--force", "vlc\n"]) {
      const config = settings(machine()); config[field] = [name]
      assert.throws(() => homebrewBundle(fakeSystem(), config, "/brew"), /Invalid (formula|cask)/u)
    }
  })
}
