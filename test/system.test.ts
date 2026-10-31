import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { checked, liveSystem } from "../src/system.ts"

test("process execution preserves argument boundaries, stdin, stdout, stderr, and exit status", async () => {
  const system = liveSystem(process.env)
  const result = await Effect.runPromise(system.run({
    file: process.execPath,
    args: ["-e", 'process.stdin.setEncoding("utf8");process.stdin.on("data",s=>process.stdout.write(JSON.stringify([process.argv[1],s])));process.stdin.on("end",()=>{process.stderr.write("diagnostic");process.exitCode=7})', "a '$() with spaces"],
    input: "input\nwith newlines"
  }))
  assert.deepEqual(JSON.parse(result.stdout), ["a '$() with spaces", "input\nwith newlines"])
  assert.equal(result.code, 7)
  assert.equal(result.stderr, "diagnostic")
  await assert.rejects(Effect.runPromise(checked(system, { file: process.execPath, args: ["-e", 'process.stderr.write("failure");process.exitCode=9'] })), /failure/u)
  await assert.rejects(Effect.runPromise(system.run({ file: "/nonexistent/bootstrap-command", args: [] })), /ENOENT/u)
})

test("interactive commands receive scripted stdin and preserve exit status", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-machine-input-"))
  try {
    const file = join(root, "received stdin")
    const input = 'cask "ghostty"\ncask "vlc"\n'
    const result = await Effect.runPromise(liveSystem(process.env).run({
      file: process.execPath,
      args: ["-e", 'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], fs.readFileSync(0)); process.exitCode = 7', file],
      input, interactive: true
    }))
    assert.equal(result.code, 7)
    assert.equal(await readFile(file, "utf8"), input)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("filesystem adapter creates parents and distinguishes missing paths from other read failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "new-machine-system-"))
  const system = liveSystem(process.env)
  try {
    const file = join(root, "parent with spaces", "profile")
    assert.equal(await Effect.runPromise(system.readText(file)), undefined)
    assert.equal(await Effect.runPromise(system.directory(join(root, "parent with spaces"))), false)
    await Effect.runPromise(system.writeText(file, "contents\n"))
    assert.equal(await readFile(file, "utf8"), "contents\n")
    assert.equal(await Effect.runPromise(system.directory(join(root, "parent with spaces"))), true)
    assert.equal(await Effect.runPromise(system.directory(file)), false)
    assert.equal(await Effect.runPromise(system.executable(root)), false)
    assert.equal(await Effect.runPromise(system.executable(process.execPath)), true)
    await assert.rejects(Effect.runPromise(system.readText(root)), /Read/u)
  } finally { await rm(root, { recursive: true, force: true }) }
})
