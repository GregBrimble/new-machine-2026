import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { configurationCheckout } from "../src/resources/checkout.ts"
import { liveSystem } from "../src/system.ts"

test("the configuration checkout clones once and preserves local branches, changes and remotes", async () => {
  const root = mkdtempSync(join(tmpdir(), "new-machine-checkout-"))
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" }
  const git = (...args: string[]) => execFileSync("git", args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  try {
    const source = join(root, "origin"), directory = join(root, "repos/host/owner/config")
    git("init", "-b", "main", source)
    writeFileSync(join(source, "config.txt"), "original\n")
    git("-C", source, "add", "config.txt")
    git("-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "Initial config")
    const resource = configurationCheckout(liveSystem(env), { directory, remote: source })
    assert.equal((await Effect.runPromise(resource.inspect())).status, "change")
    await Effect.runPromise(resource.apply())
    await Effect.runPromise(resource.verify())
    git("-C", directory, "checkout", "-b", "local-edits")
    writeFileSync(join(directory, "config.txt"), "my edits\n")
    const before = git("-C", directory, "status", "--porcelain")
    assert.equal((await Effect.runPromise(resource.inspect())).status, "ok")
    assert.equal(readFileSync(join(directory, "config.txt"), "utf8"), "my edits\n")
    assert.equal(git("-C", directory, "branch", "--show-current"), "local-edits")
    assert.equal(git("-C", directory, "status", "--porcelain"), before)
    git("-C", directory, "remote", "set-url", "origin", join(root, "unrelated"))
    await assert.rejects(Effect.runPromise(resource.inspect()), /Preserving.*origin/u)
    assert.equal(readFileSync(join(directory, "config.txt"), "utf8"), "my edits\n")
    const inside = configurationCheckout(liveSystem(env), { directory: join(directory, ".git"), remote: source })
    await assert.rejects(Effect.runPromise(inside.inspect()))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
