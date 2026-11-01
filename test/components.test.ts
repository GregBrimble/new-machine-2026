import assert from "node:assert/strict"
import test from "node:test"
import { Effect } from "effect"
import { components } from "../src/components/index.ts"
import { runComponents } from "../src/runner.ts"
import { fakeSystem, machine } from "./helpers.ts"

test("every profile assembles a valid component graph without querying the machine", async () => {
  for (const profile of ["shared", "personal", "cloudflare"] as const) {
    const catalog = components(fakeSystem(), { ...machine(), profile })
    const states = await Effect.runPromise(runComponents(catalog, { mode: "preview" }))
    assert.equal(states.length, 15)
    assert.ok(states.every(state => state.phase === "done" && state.status === "pending"))
    assert.ok(states.find(state => state.id === "git-signing")!.dependencies.includes("git-signing-key"))
    assert.ok(states.find(state => state.id === "spotlight")!.interaction.includes("accessibility"))
  }
})
