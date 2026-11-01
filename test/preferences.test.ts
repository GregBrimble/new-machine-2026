import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { Effect } from "effect"
import { readBooleanPreference } from "../src/preferences.ts"
import { liveSystem } from "../src/system.ts"
import { fakeSystem, result } from "./helpers.ts"

for (const value of [null, true, false]) {
  test(`a Boolean preference preserves ${value}`, async () => {
    const system = fakeSystem({ run: () => Effect.succeed(result(JSON.stringify(value === null ? null : { value }))) })
    assert.equal(await Effect.runPromise(readBooleanPreference(system, "domain", "key")), value)
  })
}

for (const value of [null, 0, 1, NaN, Infinity, "false", [], {}]) {
  test(`a present preference rejects a non-Boolean value: ${String(value)}`, async () => {
    const system = fakeSystem({ run: () => Effect.succeed(result(JSON.stringify({ value }))) })
    await assert.rejects(Effect.runPromise(readBooleanPreference(system, "domain", "key")), /Read domain.key/u)
  })
}

for (const output of ["false", "[]", "{}", "not JSON", ""]) {
  test(`a preference rejects a malformed response: ${JSON.stringify(output)}`, async () => {
    const system = fakeSystem({ run: () => Effect.succeed(result(output)) })
    await assert.rejects(Effect.runPromise(readBooleanPreference(system, "domain", "key")), /Read domain.key/u)
  })
}

test("a failed preference read never becomes a missing value", async () => {
  const system = fakeSystem({ run: () => Effect.succeed(result("null", 1, "localized failure")) })
  await assert.rejects(Effect.runPromise(readBooleanPreference(system, "domain", "key")), /localized failure/u)
})

test("Foundation reports a missing domain and key as null without creating preferences", async () => {
  const domain = `com.gregbrimble.new-machine-2026.test.${randomUUID()}`
  assert.equal(await Effect.runPromise(readBooleanPreference(liveSystem(process.env), domain, "missing")), null)
  assert.equal(await Effect.runPromise(readBooleanPreference(liveSystem(process.env), "NSGlobalDomain", randomUUID())), null)
})
