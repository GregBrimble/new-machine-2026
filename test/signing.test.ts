import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { machine } from "./helpers.ts"
import { gitSigning, gitSigningKey, signingProgram, settings as signingDefaults } from "../src/components/signing.ts"
import { runComponents } from "../src/runner.ts"
import { checked, liveSystem } from "../src/system.ts"
import type { Command, System } from "../src/system.ts"

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "new-machine signing '"))
  const config = signingDefaults(machine(root))
  const env = { HOME: root, PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: join(root, ".gitconfig"), GIT_CONFIG_NOSYSTEM: "1", SSH_AUTH_SOCK: join(root, "agent") }
  const agent = execFileSync("/usr/bin/ssh-agent", ["-s", "-a", env.SSH_AUTH_SOCK], { encoding: "utf8", env })
  const pid = Number(/SSH_AGENT_PID=(\d+);/u.exec(agent)![1])
  const native = liveSystem(env)
  const commands: Command[] = []
  const state = { terminal: true, failUnlock: false }
  const system: System = {
    ...native,
    run: command => {
      commands.push(command)
      if (command.file === "/bin/test" && command.args[0] === "-t") return Effect.succeed({ code: state.terminal ? 0 : 1, stdout: "", stderr: "" })
      if (command.file === "/usr/bin/ssh-keygen" && command.args[0] === "-t") {
        assert.equal(command.interactive, true)
        assert.equal(command.args.includes("-N"), false, "Production key generation leaves passphrase entry to ssh-keygen")
        // Disposable test key; never touch the user's keys or Keychain.
        return native.run({ ...command, args: [...command.args, "-N", ""], interactive: false })
      }
      if (command.file === "/usr/bin/ssh-add" && command.args[0] === "--apple-use-keychain") {
        assert.equal(command.interactive, true)
        if (state.failUnlock) return Effect.succeed({ code: 1, stdout: "", stderr: "Unlock cancelled" })
        return native.run({ file: command.file, args: command.args.slice(1) })
      }
      return native.run(command)
    }
  }
  const key = gitSigningKey(system, config)
  const signing = { ...gitSigning(system, config), dependencies: [key.id] }
  const run = () => Effect.runPromise(runComponents([key, signing], { mode: "apply", failFast: true }))
  const git = (...args: string[]) => Effect.runPromise(checked(native, { file: "git", args }))
  return { root, config, env, native, system, commands, state, key, signing, run, git,
    dispose: () => { process.kill(pid); rmSync(root, { recursive: true, force: true }) } }
}

test("native SSH signs and verifies commits and tags, preserves identities, and converges", async () => {
  const f = await fixture()
  try {
    await f.git("config", "--global", "user.name", "Test Person")
    await f.git("config", "--global", "user.email", "test@example.com")
    await f.git("config", "--global", "user.signingkey", "old-gpg-key")
    const result = await f.run()
    assert.ok(result.every(component => component.status === "ok" && component.repaired))
    assert.equal(await f.git("config", "--global", "user.name"), "Test Person")
    assert.equal(await f.git("config", "--global", "user.email"), "test@example.com")
    await f.git("init", join(f.root, "repo"))
    await f.git("-C", join(f.root, "repo"), "commit", "--allow-empty", "-m", "Signed fixture")
    await f.git("-C", join(f.root, "repo"), "verify-commit", "HEAD")
    await f.git("-C", join(f.root, "repo"), "tag", "-m", "Signed tag", "v1")
    await f.git("-C", join(f.root, "repo"), "verify-tag", "v1")
    const before = [f.env.GIT_CONFIG_GLOBAL, f.config.allowedSignersPath, f.config.programPath, f.config.keyPath].map(path => readFileSync(path))
    f.commands.length = 0
    assert.ok((await f.run()).every(component => !component.repaired))
    assert.deepEqual([f.env.GIT_CONFIG_GLOBAL, f.config.allowedSignersPath, f.config.programPath, f.config.keyPath].map(path => readFileSync(path)), before)
    assert.equal(f.commands.some(command => command.args.includes("--replace-all") || command.interactive), false)

    // Local verification must work with no agent and must not access Keychain.
    const offline = liveSystem({ ...f.env, SSH_AUTH_SOCK: join(f.root, "missing-agent") })
    await Effect.runPromise(checked(offline, { file: "git", args: ["-C", join(f.root, "repo"), "verify-commit", "HEAD"] }))
  } finally { f.dispose() }
})

test("the signing helper reloads a missing key only for signing and forwards Git's arguments", async () => {
  const f = await fixture()
  try {
    await f.run()
    await Effect.runPromise(checked(f.native, { file: "/usr/bin/ssh-add", args: ["-d", f.config.keyPath] }))
    const shim = join(f.root, "ssh-add")
    // Replace only the platform boundary; keep the generated helper's control flow.
    writeFileSync(shim, '#!/bin/sh\nif [ "$1" = --apple-use-keychain ]; then\n  shift\nfi\nexec /usr/bin/ssh-add "$@"\n')
    chmodSync(shim, 0o700)
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    writeFileSync(f.config.programPath, signingProgram(f.config).replaceAll("/usr/bin/ssh-add", quote(shim)))
    const payload = join(f.root, "payload")
    writeFileSync(payload, "fixture\n")
    await Effect.runPromise(checked(f.native, { file: f.config.programPath, args: ["-Y", "sign", "-n", "git", "-f", `${f.config.keyPath}.pub`, payload] }))
    assert.ok(existsSync(`${payload}.sig`))
    await Effect.runPromise(checked(f.native, { file: "/usr/bin/ssh-add", args: ["-T", `${f.config.keyPath}.pub`] }))
  } finally { f.dispose() }
})

test("inspection is read-only and headless creation fails before writing a key or enabling signing", async () => {
  const f = await fixture()
  try {
    const observed = await Effect.runPromise(runComponents([f.key, f.signing], { mode: "plan" }))
    assert.ok(observed.every(component => component.status === "change"))
    assert.equal(existsSync(f.config.keyPath), false)
    assert.equal(existsSync(f.env.GIT_CONFIG_GLOBAL), false)
    assert.equal(f.commands.some(command => command.interactive), false)
    f.state.terminal = false
    await assert.rejects(f.run(), /needs a terminal/u)
    assert.equal(existsSync(f.config.keyPath), false)
    assert.equal(existsSync(f.env.GIT_CONFIG_GLOBAL), false)
  } finally { f.dispose() }
})

test("cancelled unlock preserves the key pair and leaves existing GPG signing configuration intact", async () => {
  const f = await fixture()
  try {
    await f.git("config", "--global", "user.signingkey", "old-gpg-key")
    f.state.failUnlock = true
    await assert.rejects(f.run(), /Unlock cancelled/u)
    assert.ok(existsSync(f.config.keyPath))
    assert.equal(await f.git("config", "--global", "user.signingkey"), "old-gpg-key")
    const before = readFileSync(f.config.keyPath)
    f.state.failUnlock = false
    await f.run()
    assert.deepEqual(readFileSync(f.config.keyPath), before)
  } finally { f.dispose() }
})

test("an incomplete or invalid key pair is preserved and unrelated local trust entries survive repair", async () => {
  const f = await fixture()
  try {
    await Effect.runPromise(f.native.writeText(f.config.keyPath, "existing private key"))
    await assert.rejects(f.run(), /Incomplete key pair/u)
    assert.equal(readFileSync(f.config.keyPath, "utf8"), "existing private key")
    rmSync(f.config.keyPath)
    await Effect.runPromise(f.native.writeText(`${f.config.keyPath}.pub`, "not a key\n"))
    await assert.rejects(f.run(), /Expected one Ed25519/u)
    rmSync(`${f.config.keyPath}.pub`)
    await Effect.runPromise(f.native.writeText(f.config.allowedSignersPath, "# Existing trust entries\n"))
    await f.run()
    assert.ok(readFileSync(f.config.allowedSignersPath, "utf8").startsWith("# Existing trust entries\n* ssh-ed25519 "))
  } finally { f.dispose() }
})

test("signing configuration rejects path collisions and injected lines", () => {
  for (const path of ["relative", "/tmp/bad\npath", "/tmp/bad\0path"]) {
    const config = { git: { signing: signingDefaults(machine()) } }
    config.git.signing.keyPath = path
    assert.throws(() => gitSigningKey(liveSystem({}), config.git.signing), /paths/u)
  }
  const config = { git: { signing: signingDefaults(machine()) } }
  config.git.signing.allowedSignersPath = `${config.git.signing.keyPath}.pub`
  assert.throws(() => gitSigningKey(liveSystem({}), config.git.signing), /distinct/u)
})
