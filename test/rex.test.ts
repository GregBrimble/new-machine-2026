import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { rex, settings } from "../src/components/rex.ts"
import { runComponents } from "../src/runner.ts"
import { fakeSystem, machine, result } from "./helpers.ts"
import type { Command } from "../src/system.ts"

function fixture() {
  const config = settings(machine()), commands: Command[] = []
  const state = { installed: false, local: undefined as string | undefined, encrypted: "ciphertext", decryptFailure: false, ineffective: false }
  const system = fakeSystem({
    executable: () => Effect.succeed(state.installed),
    mkdir: () => Effect.void,
    readText: path => Effect.succeed(path === config.localCask ? state.local : state.encrypted),
    writeText: () => Effect.void,
    run: command => Effect.sync(() => {
      commands.push(command)
      if (command.file === "/usr/bin/mktemp") return result("/tmp/private-stage\n")
      if (command.file === "/bin/mv" || command.file === "/bin/rm") return result()
      if (command.file === "/age/bin/age") {
        assert.deepEqual(command.args, ["--decrypt", "--output", "/tmp/private-stage"])
        assert.equal(command.input, "ciphertext")
        return state.decryptFailure ? result("", 1, "incorrect passphrase") : result()
      }
      assert.equal(command.file, machine().brew)
      if (command.args[0] === "--prefix") return result("/age")
      if (command.args[0] === "--repository") return result("/brew/tap")
      if (command.args[0] === "trust") {
        assert.deepEqual(command.args, ["trust", "--cask", "gregbrimble/new-machine-private/rex"])
        return result()
      }
      assert.deepEqual(command.args, ["install", "--cask", "--adopt", "gregbrimble/new-machine-private/rex"])
      assert.equal(command.interactive, true)
      if (!state.ineffective) state.installed = true
      return result()
    })
  })
  const component = rex(system, config, machine().brew)
  const run = () => Effect.runPromise(runComponents([component], { mode: "apply", failFast: true }))
  return { state, commands, component, run }
}

test("Rex decrypts completely before installing and a repeat run needs no passphrase", async () => {
  const f = fixture()
  await f.run()
  const decrypt = f.commands.findIndex(command => command.file === "/age/bin/age")
  const install = f.commands.findIndex(command => command.args[0] === "install")
  assert.ok(decrypt >= 0 && install > decrypt)
  assert.equal(f.commands.at(-1)?.file, "/bin/rm")
  f.commands.length = 0
  await f.run()
  assert.deepEqual(f.commands, [])
})

test("Rex status is read-only and never decrypts private files", async () => {
  const f = fixture()
  assert.equal((await Effect.runPromise(f.component.inspect())).status, "change")
  assert.deepEqual(f.commands, [])
})

test("Rex rejects an incorrect passphrase before changing the tap and removes staging", async () => {
  const f = fixture(); f.state.decryptFailure = true
  await assert.rejects(f.run(), /incorrect passphrase/u)
  assert.equal(f.commands.some(command => command.file === "/bin/mv" || command.args[0] === "install"), false)
  assert.equal(f.commands.at(-1)?.file, "/bin/rm")
})

test("Rex accepts an explicit local cask for unattended tests without decrypting", async () => {
  const f = fixture(); f.state.local = 'cask "rex" do\nend\n'
  await f.run()
  assert.equal(f.commands.some(command => command.file === "/age/bin/age"), false)
  assert.equal(f.state.installed, true)
})

test("Rex fails verification when Homebrew does not install its executable", async () => {
  const f = fixture(); f.state.ineffective = true
  await assert.rejects(f.run(), /Verification failed/u)
})

test("a missing private cask fails clearly and never starts installation", async () => {
  const f = fixture(); f.state.encrypted = ""
  await assert.rejects(f.run(), /Missing private\/rex.rb.age/u)
  assert.equal(f.commands.some(command => command.args[0] === "install"), false)
})

test("an empty local cask fails before changing Homebrew", async () => {
  const f = fixture(); f.state.local = "  \n"
  await assert.rejects(f.run(), /Local private cask is empty/u)
  assert.equal(f.commands.some(command => command.file === machine().brew || command.file === "/bin/mv"), false)
  assert.equal(f.commands.at(-1)?.file, "/bin/rm")
})
