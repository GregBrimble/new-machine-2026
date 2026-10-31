import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { configuration } from "../src/config.ts"
import { liveSystem } from "../src/system.ts"
import { zshStartupDirectory } from "../src/zsh.ts"

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "new-machine-zsh-directory-"))
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: "/usr/bin:/bin" }
  return {
    home, env,
    resolve: () => Effect.runPromise(zshStartupDirectory(liveSystem(env))),
    dispose: () => rmSync(home, { recursive: true, force: true })
  }
}

test("zsh supplies HOME as its default startup directory", async () => {
  const f = fixture()
  try { assert.equal(await f.resolve(), f.home) }
  finally { f.dispose() }
})

test("zsh honors an inherited ZDOTDIR and preserves whitespace in its path", async () => {
  const f = fixture()
  try {
    f.env.ZDOTDIR = join(f.home, "custom zsh directory \n")
    assert.equal(await f.resolve(), f.env.ZDOTDIR)
  } finally { f.dispose() }
})

test("zsh resolves a non-exported ZDOTDIR from .zshenv without loading login or interactive profiles", async () => {
  const f = fixture()
  try {
    const directory = join(f.home, "zsh config")
    mkdirSync(directory)
    writeFileSync(join(f.home, ".zshenv"), 'print -r -- "startup output"\nZDOTDIR="$HOME/zsh config"\n')
    for (const base of [f.home, directory]) {
      writeFileSync(join(base, ".zprofile"), "exit 81\n")
      writeFileSync(join(base, ".zshrc"), "exit 82\n")
    }
    const resolved = await f.resolve()
    assert.equal(resolved, directory)
    const config = configuration(f.home, resolved, "shared")
    assert.equal(config.homebrewProfile, join(directory, ".zprofile"))
    assert.equal(config.miseProfile, join(directory, ".zshrc"))
  } finally { f.dispose() }
})

test(".zshenv can override the inherited startup directory", async () => {
  const f = fixture()
  try {
    f.env.ZDOTDIR = join(f.home, "inherited directory")
    mkdirSync(f.env.ZDOTDIR)
    writeFileSync(join(f.env.ZDOTDIR, ".zshenv"), 'ZDOTDIR="$HOME/resolved directory"\n')
    assert.equal(await f.resolve(), join(f.home, "resolved directory"))
  } finally { f.dispose() }
})

for (const code of [0, 7]) {
  test(`zsh exiting from .zshenv with status ${code} fails directory resolution`, async () => {
    const f = fixture()
    try {
      writeFileSync(join(f.home, ".zshenv"), `exit ${code}\n`)
      await assert.rejects(f.resolve(), /zsh startup directory/u)
    } finally { f.dispose() }
  })
}

for (const directory of ["", "relative/directory"]) {
  test(`a non-absolute ZDOTDIR (${JSON.stringify(directory)}) fails directory resolution`, async () => {
    const f = fixture()
    try {
      f.env.ZDOTDIR = directory
      await assert.rejects(f.resolve(), /absolute startup directory/u)
    } finally { f.dispose() }
  })
}
