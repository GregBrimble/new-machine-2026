import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { appearance } from "../src/components/appearance.ts"
import { runComponents } from "../src/runner.ts"
import { fakeSystem, result } from "./helpers.ts"

function fixture() {
  const state = { dark: false, automatic: true, absent: false, invalid: false, ineffective: false }
  let writes = 0
  const system = fakeSystem({ run: command => Effect.sync(() => {
    if (command.file === "osascript") {
      if (command.args[1].includes("get dark mode")) return result(String(state.dark))
      writes++
      if (!state.ineffective) state.dark = command.args[1].endsWith("true")
    } else if (command.file === "/usr/bin/osascript") {
      assert.deepEqual(command.args.slice(-2), ["NSGlobalDomain", "AppleInterfaceStyleSwitchesAutomatically"])
      return state.invalid ? result("", 1, "Permission denied") : result(JSON.stringify(state.absent ? null : { value: state.automatic }))
    } else {
      assert.equal(command.file, "defaults")
      assert.equal(command.args[0], "write")
      writes++; state.automatic = false
    }
    return result()
  }) })
  const run = (desired: "dark" | "light" = "dark") => Effect.runPromise(runComponents([appearance(system, desired)], { mode: "apply", failFast: true }))
  return { state, run, writes: () => writes }
}

test("appearance converges and supports light mode", async () => {
  const f = fixture()
  await f.run(); assert.equal(f.state.dark, true); assert.equal(f.state.automatic, false)
  const writes = f.writes()
  await f.run(); assert.equal(f.writes(), writes)
  await f.run("light"); assert.equal(f.state.dark, false)
})

test("an absent automatic appearance preference needs no write", async () => {
  const f = fixture(); f.state.absent = true; f.state.dark = true
  await f.run(); assert.equal(f.writes(), 0)
})

for (const failure of ["invalid", "ineffective"] as const) {
  test(`appearance surfaces ${failure} changes`, async () => {
    const f = fixture(); f.state[failure] = true
    await assert.rejects(f.run(), failure === "invalid" ? /Permission denied/u : /Verification failed/u)
  })
}

for (const output of ["1", "yes", '"false"', "null"]) {
  test(`dark mode rejects a non-Boolean response: ${output}`, async () => {
    const system = fakeSystem({ run: () => Effect.succeed(result(output)) })
    await assert.rejects(Effect.runPromise(appearance(system, "dark").inspect()), /Appearance/u)
  })
}
