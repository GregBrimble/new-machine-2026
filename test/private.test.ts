import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { executable, temporaryDirectory } from "./helpers.ts"

const script = fileURLToPath(new URL("../scripts/encrypt-private.sh", import.meta.url))
for (const fail of [false, true]) {
  test(`private encryption ${fail ? "preserves the previous ciphertext on cancellation" : "publishes only the completed ciphertext"}`, t => {
    const root = temporaryDirectory(t, "new-machine-encryption-"), source = join(root, "secret.rb"), output = join(root, "secret.rb.age")
    writeFileSync(source, "private contents", { mode: 0o600 })
    writeFileSync(output, "previous ciphertext")
    executable(join(root, "age"), `#!/bin/bash
[[ "$1" == --encrypt && "$2" == --passphrase && "$3" == --armor && "$4" == --output ]] || exit 97
printf 'encrypted fixture' > "$5"
exit ${fail ? 1 : 0}
`)
    const result = spawnSync("/bin/bash", [script, source, output], { encoding: "utf8", env: { ...process.env, PATH: `${root}:/usr/bin:/bin` } })
    assert.equal(result.status, fail ? 1 : 0, result.stderr)
    assert.equal(readFileSync(output, "utf8"), fail ? "previous ciphertext" : "encrypted fixture")
    assert.equal(result.stdout.includes("private contents"), false)
    assert.equal(readFileSync(source, "utf8"), "private contents")
    if (!fail) assert.equal(statSync(output).mode & 0o777, 0o600)
    assert.deepEqual(readdirSync(root).filter(name => name.startsWith("secret.rb.age.")), [])
    assert.ok(existsSync(source))
  })
}
