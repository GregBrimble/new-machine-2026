import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { trashSettings } from "../src/components/trash.ts"
import { runComponents } from "../src/runner.ts"
import { liveSystem } from "../src/system.ts"
import type { Command, System } from "../src/system.ts"

function fixture(value?: unknown) {
  const state = { value, readError: false, writeError: false, ignoreWrite: false }
  const commands: Command[] = []
  const system: System = {
    ...liveSystem(process.env),
    run: command => Effect.sync(() => {
      commands.push(command)
      if (command.file === "/usr/bin/osascript") {
        assert.deepEqual(command.args.slice(-2), ["com.apple.finder", "FXRemoveOldTrashItems"])
        return state.readError ? { code: 1, stdout: "", stderr: "Permission denied" }
          : { code: 0, stdout: JSON.stringify(state.value === undefined ? null : { value: state.value }), stderr: "" }
      }
      assert.equal(command.file, "defaults")
      assert.deepEqual(command.args.slice(1, 3), ["com.apple.finder", "FXRemoveOldTrashItems"])
      assert.equal(command.args[0], "write")
      assert.equal(command.args[3], "-bool")
      if (state.writeError) return { code: 1, stdout: "", stderr: "Write failed" }
      if (!state.ignoreWrite) state.value = command.args[4] === "true"
      return { code: 0, stdout: "", stderr: "" }
    })
  }
  const run = (enabled = true) => Effect.runPromise(runComponents([trashSettings(system, enabled)], { mode: "apply", failFast: true }))
  return { state, commands, run }
}

for (const initial of [undefined, false]) {
  test(`automatic Trash removal is enabled from ${String(initial)} and converges`, async () => {
    const f = fixture(initial)
    await f.run()
    assert.equal(f.state.value, true)
    f.commands.length = 0
    await f.run()
    assert.equal(f.commands.some(command => command.args[0] === "write"), false)
    await f.run(false)
    assert.equal(f.state.value, false)
  })
}

for (const failure of ["readError", "writeError", "ignoreWrite"] as const) {
  test(`automatic Trash removal surfaces ${failure}`, async () => {
    const f = fixture(false); f.state[failure] = true
    await assert.rejects(f.run())
    if (failure === "readError") assert.equal(f.commands.some(command => command.args[0] === "write"), false)
  })
}

test("an invalid Finder boolean fails without overwriting it", async () => {
  const f = fixture("unexpected")
  await assert.rejects(f.run(), /boolean/iu)
  assert.equal(f.commands.some(command => command.args[0] === "write"), false)
})
