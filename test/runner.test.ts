import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { options } from "../src/cli.ts"
import { runComponents } from "../src/runner.ts"
import type { ComponentEvent, Component } from "../src/runner.ts"
import { BootstrapError } from "../src/system.ts"

function fixture() {
  const calls: string[] = [], events: ComponentEvent[] = []
  const component = (id: string, dependencies: string[] = []): Component => ({
    id, description: `Configure ${id}`, dependencies,
    inspect: () => Effect.sync(() => { calls.push(`inspect:${id}`); return { status: "change", detail: `Repair ${id}` } as const }),
    apply: () => Effect.sync(() => { calls.push(`apply:${id}`) }),
    verify: () => Effect.sync(() => { calls.push(`verify:${id}`) })
  })
  const run = (components: Component[], settings: Parameters<typeof runComponents>[1]) => Effect.runPromise(runComponents(components, {
    ...settings, onEvent: event => events.push(JSON.parse(JSON.stringify(event)))
  }))
  return { calls, events, component, run }
}

test("a targeted repair runs its dependencies in order and leaves unrelated components alone", async () => {
  const f = fixture()
  const states = await f.run([f.component("app", ["packages"]), f.component("unrelated"), f.component("packages")], { mode: "apply", components: ["app"] })
  assert.deepEqual(f.calls, ["inspect:packages", "apply:packages", "verify:packages", "inspect:app", "apply:app", "verify:app"])
  assert.deepEqual(states.map(state => [state.id, state.status, state.repaired]), [["packages", "ok", true], ["app", "ok", true]])
  assert.deepEqual(f.events.filter(event => event.component.id === "app").map(event => event.component.phase), ["idle", "inspecting", "observed", "applying", "verifying", "done"])
  assert.equal(f.events[0].component.status, "pending", "Events are immutable snapshots")
})

test("status for one component only inspects that component", async () => {
  const f = fixture()
  await f.run([f.component("app", ["packages"]), f.component("packages")], { mode: "plan", components: ["app"] })
  assert.deepEqual(f.calls, ["inspect:app"])
})

test("repair all reports errors, blocks dependent repairs, and continues independent components", async () => {
  const f = fixture(), broken = f.component("broken")
  broken.apply = () => Effect.fail(new BootstrapError("broken", "permission denied"))
  const states = await f.run([broken, f.component("dependent", ["broken"]), f.component("independent")], { mode: "apply" })
  assert.deepEqual(states.map(state => state.status), ["error", "blocked", "ok"])
  assert.match(states[0].detail, /permission denied/u)
  assert.equal(f.calls.includes("inspect:dependent"), false)
  assert.ok(f.calls.includes("verify:independent"))
})

test("status continues after an inspection error and still inspects dependent components", async () => {
  const f = fixture(), broken = f.component("broken")
  broken.inspect = () => Effect.fail(new BootstrapError("broken", "permission denied"))
  const states = await f.run([broken, f.component("dependent", ["broken"])], { mode: "plan" })
  assert.deepEqual(states.map(state => state.status), ["error", "change"])
  assert.deepEqual(f.calls, ["inspect:dependent"])
})

test("verification failure is an error and fail-fast mode stops before unrelated work", async () => {
  const f = fixture(), broken = f.component("broken")
  broken.verify = () => Effect.fail(new BootstrapError("broken", "verification failed"))
  await assert.rejects(f.run([broken, f.component("other")], { mode: "apply", failFast: true }), /verification failed/u)
  assert.equal(f.calls.includes("inspect:other"), false)
  assert.equal(f.events.at(-1)?.component.status, "error")
  assert.equal(f.events.at(-1)?.component.repaired, false)
})

test("a repair with no independent status query remains unknown after successful verification", async () => {
  const f = fixture(), opaque = f.component("opaque")
  opaque.inspect = () => Effect.succeed({ status: "unknown", detail: "Cannot query status" })
  const [state] = await f.run([opaque], { mode: "apply" })
  assert.equal(state.status, "unknown")
  assert.equal(state.repaired, true)
})

test("unknown IDs, missing dependencies, duplicate IDs and cycles fail before system calls", async () => {
  const f = fixture()
  for (const [catalog, components] of [
    [[f.component("a")], ["missing"]],
    [[f.component("a", ["missing"])], undefined],
    [[f.component("a"), f.component("a")], undefined],
    [[f.component("a", ["b"]), f.component("b", ["a"])], undefined]
  ] as const) {
    await assert.rejects(f.run([...catalog], { mode: "apply", components }))
  }
  assert.deepEqual(f.calls, [])
  assert.deepEqual(f.events, [])
})

test("preview emits the selected catalog without inspecting or repairing", async () => {
  const f = fixture()
  const states = await f.run([f.component("a")], { mode: "preview" })
  assert.deepEqual(f.calls, [])
  assert.equal(states[0].status, "pending")
  assert.equal(states[0].phase, "done")
})

test("CLI supports repeated components, structured status, and default fail-fast application", () => {
  assert.deepEqual(options(["--status", "--json", "--component", "appearance", "--component", "trash"]), {
    mode: "plan", profile: "shared", components: ["appearance", "trash"], json: true, failFast: false
  })
  assert.equal(options([]).failFast, true)
  assert.equal(options(["--json"]).failFast, false)
  for (const args of [["--status", "--plan"], ["--component"], ["--profile", "invalid"], ["--unknown"], ["positional"]]) assert.throws(() => options(args))
})

test("the CLI emits a consumable component event stream and structured fatal errors", () => {
  const home = mkdtempSync(join(tmpdir(), "new-machine-cli-"))
  try {
    const env = { ...process.env, HOME: home, ZDOTDIR: home, BOOTSTRAP_BREW_BIN: "/fixture/bin/brew", BOOTSTRAP_MISE_BIN: "/fixture/mise" }
    const run = (...args: string[]) => spawnSync(process.execPath, ["src/main.ts", "--json", ...args], {
      cwd: new URL("../", import.meta.url), env, encoding: "utf8", timeout: 10_000
    })
    const result = run("--dry-run", "--component", "appearance")
    assert.equal(result.status, 0, result.stderr)
    const events = result.stdout.trim().split("\n").map(line => JSON.parse(line))
    assert.equal(events[0].type, "start")
    assert.deepEqual(events.filter(event => event.type === "component").map(event => event.component.id), ["appearance", "appearance"])
    assert.equal(events.at(-1).type, "complete")
    assert.equal(events.at(-1).success, true)
    const invalid = run("--component", "nonexistent")
    assert.equal(invalid.status, 1)
    assert.equal(JSON.parse(invalid.stdout.trim().split("\n").at(-1)!).type, "fatal")
    assert.match(invalid.stderr, /Unknown component/u)
  } finally { rmSync(home, { recursive: true, force: true }) }
})


test("default verification reinspects and rejects an ineffective repair", async () => {
  let current = false, repairs = 0
  const component: Component = {
    id: "setting", description: "Set a preference",
    inspect: () => Effect.succeed({ status: current ? "ok" : "change", detail: "Preference" }),
    apply: () => Effect.sync(() => { repairs++ })
  }
  await assert.rejects(Effect.runPromise(runComponents([component], { mode: "apply", failFast: true })), /Verification failed/u)
  component.apply = () => Effect.sync(() => { current = true; repairs++ })
  const [state] = await Effect.runPromise(runComponents([component], { mode: "apply" }))
  assert.equal(state.status, "ok")
  assert.equal(state.repaired, true)
  await Effect.runPromise(runComponents([component], { mode: "apply" }))
  assert.equal(repairs, 2)
})
