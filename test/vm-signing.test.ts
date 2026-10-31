import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

test("VM askpass creates an encrypted fixture key and unlocks it without terminal input", () => {
  const root = mkdtempSync(join(tmpdir(), "new-machine-vm-signing-"))
  try {
    mkdirSync(join(root, "vm"))
    const askpass = join(root, "vm/signing-askpass.sh")
    copyFileSync(new URL("../vm/signing-askpass.sh", import.meta.url), askpass)
    chmodSync(askpass, 0o700)
    writeFileSync(join(root, "signing-passphrase"), "disposable VM test fixture\n", { mode: 0o600 })
    const key = join(root, "key")
    const env = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: "force" }
    execFileSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-f", key], { env, stdio: "ignore", timeout: 10_000 })
    const wrong = spawnSync("/usr/bin/ssh-keygen", ["-y", "-P", "incorrect fixture", "-f", key], { encoding: "utf8", timeout: 10_000 })
    assert.notEqual(wrong.status, 0)
    assert.match(wrong.stderr, /incorrect passphrase/u)
    const unlocked = execFileSync("/usr/bin/ssh-keygen", ["-y", "-f", key], { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] })
    assert.match(unlocked, /^ssh-ed25519 /u)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
