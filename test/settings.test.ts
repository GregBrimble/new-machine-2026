import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Effect } from "effect"
import { machine } from "./helpers.ts"
import { gitSettings } from "../src/components/git.ts"
import { vlcSettings, settings as vlcDefaults } from "../src/components/vlc.ts"
import { runComponents } from "../src/runner.ts"
import type { Component } from "../src/runner.ts"
import { checked, liveSystem } from "../src/system.ts"
import type { Command, System } from "../src/system.ts"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "new-machine-settings-"))
  const gitPath = join(root, "gitconfig")
  const config = { vlc: vlcDefaults(machine(root)) }
  config.vlc.configPath = join(root, "VLC preferences/vlcrc")
  const native = liveSystem({ HOME: root, PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: gitPath, GIT_CONFIG_NOSYSTEM: "1" })
  const commands: Command[] = [], writes: string[] = []
  const state = { processCode: 1, ignoreWrites: false }
  const system: System = {
    ...native,
    run: command => {
      commands.push(command)
      return command.file === "pgrep"
        ? Effect.succeed({ code: state.processCode, stdout: "", stderr: state.processCode > 1 ? "Process lookup failed" : "" })
        : native.run(command)
    },
    writeText: (path, text) => {
      writes.push(path)
      return state.ignoreWrites ? Effect.void : native.writeText(path, text)
    }
  }
  const run = (component: Component) => Effect.runPromise(runComponents([component], { mode: "apply", failFast: true }))
  const vlc = () => vlcSettings(system, config.vlc)
  const seed = (text: string) => Effect.runPromise(native.writeText(config.vlc.configPath, text))
  const read = () => readFileSync(config.vlc.configPath, "utf8")
  return { root, gitPath, config, system, state, commands, writes, run, vlc, seed, read,
    dispose: () => rmSync(root, { recursive: true, force: true }) }
}

test("native Git updates only the global setting and a repeat run makes no writes", async () => {
  const f = fixture()
  try {
    const unrelated = "# Keep my settings\n[user]\n\tname = Test Person\n[alias]\n\tst = status\n"
    writeFileSync(f.gitPath, unrelated + "[push]\n\tautoSetupRemote = false\n\tautoSetupRemote = false\n")
    const component = gitSettings(f.system, true)
    await f.run(component)
    assert.ok(readFileSync(f.gitPath, "utf8").startsWith(unrelated))
    assert.equal(await Effect.runPromise(checked(f.system, { file: "git", args: ["config", "--global", "--type=bool", "--get", "push.autoSetupRemote"] })), "true")
    const before = readFileSync(f.gitPath, "utf8")
    f.commands.length = 0
    await f.run(component)
    assert.equal(f.commands.some(command => command.args.includes("--replace-all")), false)
    assert.equal(readFileSync(f.gitPath, "utf8"), before)
  } finally { f.dispose() }
})

test("a malformed Git value fails inspection instead of being treated as missing", async () => {
  const f = fixture()
  try {
    const text = "[push]\n\tautoSetupRemote = banana\n"
    writeFileSync(f.gitPath, text)
    await assert.rejects(f.run(gitSettings(f.system, true)), /boolean/iu)
    assert.equal(readFileSync(f.gitPath, "utf8"), text)
    assert.equal(f.commands.some(command => command.args.includes("--replace-all")), false)
  } finally { f.dispose() }
})

test("missing VLC preferences create only the two requested settings and converge", async () => {
  const f = fixture()
  try {
    await f.run(f.vlc())
    assert.equal(f.read(), "[core]\nrate=2.35\nsub-language=en,any\n")
    f.writes.length = 0; f.commands.length = 0
    await f.run(f.vlc())
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.commands, [])
  } finally { f.dispose() }
})

test("VLC changes preserve the BOM, CRLF, comments, and unrelated sections and keys", async () => {
  const f = fixture()
  try {
    const text = "\uFEFF[macosx] # UI\r\nmacosx-interfacestyle=1\r\n[core] # Input\r\n# Keep this comment\r\nrate=1.000000\r\nsub-language=fr\r\nfile-caching=123\r\n[other]\r\nrate=99\r\n"
    await f.seed(text)
    await f.run(f.vlc())
    assert.equal(f.read(), text.replace("rate=1.000000", "rate=2.35").replace("sub-language=fr", "sub-language=en,any"))
    await f.run(f.vlc())
    assert.equal(f.writes.length, 1)
  } finally { f.dispose() }
})

test("VLC adds a core section without changing an unrelated unterminated value", async () => {
  const f = fixture()
  try {
    await f.seed("[macosx]\nmacosx-interfacestyle=1")
    await f.run(f.vlc())
    assert.equal(f.read(), "[macosx]\nmacosx-interfacestyle=1\n[core]\nrate=2.35\nsub-language=en,any\n")
    await f.run(f.vlc())
    assert.equal(f.writes.length, 1)
  } finally { f.dispose() }
})

test("VLC deduplicates preferences and removes overrides that defeat language selection", async () => {
  const f = fixture()
  try {
    await f.seed("[core]\nrate=1\nrate=3\nsub-language=fr\nsub-track=0\nsub-track-id=4\nspu=0\n[core]\nsub-language=de\nsub-autodetect-fuzzy=3\n")
    await f.run(f.vlc())
    assert.equal(f.read(), "[core]\nrate=2.35\nsub-language=en,any\n[core]\nsub-autodetect-fuzzy=3\n")
    await f.run(f.vlc())
    assert.equal(f.writes.length, 1)
  } finally { f.dispose() }
})

test("correct VLC values retain their representation and need no shutdown", async () => {
  const f = fixture()
  try {
    const text = "\uFEFF[core]\r\nrate=2.350000\r\nsub-language=en,any\r\nsub-track=-1\r\nspu=1"
    await f.seed(text)
    f.state.processCode = 0
    await f.run(f.vlc())
    assert.equal(f.read(), text)
    assert.deepEqual(f.writes, [])
    assert.deepEqual(f.commands, [])
  } finally { f.dispose() }
})

for (const processCode of [0, 2]) {
  test(`VLC preferences are not changed when process inspection returns ${processCode}`, async () => {
    const f = fixture()
    try {
      const text = "[core]\nrate=1\n"
      await f.seed(text)
      f.state.processCode = processCode
      await assert.rejects(f.run(f.vlc()), processCode === 0 ? /Close VLC/u : /Process lookup failed/u)
      assert.equal(f.read(), text)
      assert.deepEqual(f.writes, [])
    } finally { f.dispose() }
  })
}

test("VLC verifies the written preferences before reporting success", async () => {
  const f = fixture()
  try {
    f.state.ignoreWrites = true
    await assert.rejects(f.run(f.vlc()), /vlc-settings/u)
  } finally { f.dispose() }
})

test("VLC configuration rejects invalid rates and injected preference lines", () => {
  for (const playbackRate of [0, -1, Infinity, NaN]) {
    const config = { vlc: vlcDefaults(machine()) }
    config.vlc.playbackRate = playbackRate
    assert.throws(() => vlcSettings(liveSystem({}), config.vlc), /playback rate/u)
  }
  const config = { vlc: vlcDefaults(machine()) }
  config.vlc.subtitleLanguage = "en,any\nrate=99"
  assert.throws(() => vlcSettings(liveSystem({}), config.vlc), /subtitle languages/u)
})
