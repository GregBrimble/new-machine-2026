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
    } else {
      assert.equal(command.file, "defaults")
      if (command.args[0] === "read") return state.invalid ? result("", 1, "Permission denied")
        : state.absent ? result("", 1, "The domain/default pair does not exist") : result(state.automatic ? "1" : "0")
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
