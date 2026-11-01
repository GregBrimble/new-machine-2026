import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { spotlight } from "../src/components/spotlight.ts"
import { runComponents } from "../src/runner.ts"
import type { Command } from "../src/system.ts"
import { fakeSystem, result } from "./helpers.ts"

function fixture(rootAlias = false, denied = false) {
  const commands: Command[] = [], directories: string[] = []
  const system = fakeSystem({
    mkdir: path => Effect.sync(() => { directories.push(path) }),
    realpath: path => Effect.succeed(rootAlias ? "/" : path),
    run: command => Effect.sync(() => { commands.push(command); return denied ? result("", 1, "Enable Accessibility for your terminal") : result() })
  })
  const run = (folders: string[], mode: "apply" | "plan" = "apply") => Effect.runPromise(runComponents([spotlight(system, folders)], { mode, failFast: true }))
  return { commands, directories, run }
}

test("Spotlight status avoids UI; repair deduplicates paths and keeps unknown status", async () => {
  const f = fixture(), folders = ["/Users/test/Developer", "/opt/homebrew"]
  await f.run(folders, "plan"); assert.equal(f.commands.length, 0); assert.equal(f.directories.length, 0)
  const [state] = await f.run([...folders, folders[0]])
  assert.equal(state.status, "unknown"); assert.equal(state.repaired, true)
  assert.deepEqual(f.commands[0].args, ["-", ...folders]); assert.equal(f.commands[0].interactive, true)
})

test("an empty exclusion list avoids automation", async () => {
  const f = fixture(); await f.run([]); assert.equal(f.commands.length, 0); assert.equal(f.directories.length, 0)
})

test("Spotlight surfaces denied access and rejects paths resolving to root", async () => {
  await assert.rejects(fixture(false, true).run(["/Developer"]), /Accessibility/u)
  const f = fixture(true)
  await assert.rejects(f.run(["/Developer"]), /filesystem root/u); assert.equal(f.commands.length, 0)
  for (const path of ["/", "relative"]) assert.throws(() => spotlight(fakeSystem(), [path]), /Spotlight|absolute/u)
})
