import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TestContext } from "node:test"
import type { Machine } from "../src/machine.ts"
import type { CommandResult, System } from "../src/system.ts"

export const machine = (home = "/Users/test", zshDirectory = home): Machine => ({ home, zshDirectory, profile: "shared", brew: "/opt/homebrew/bin/brew", mise: "/opt/homebrew/opt/mise/bin/mise" })
export const result = (stdout = "", code = 0, stderr = ""): CommandResult => ({ stdout, code, stderr })
export function temporaryDirectory(t: TestContext, prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(path, { recursive: true, force: true }))
  return path
}
export function executable(path: string, contents: string): void {
  writeFileSync(path, contents)
  chmodSync(path, 0o755)
}
export function fakeSystem(overrides: Partial<System> = {}): System {
  const unexpected = () => { throw new Error("Unexpected system call") }
  return { run: unexpected, executable: unexpected, directory: unexpected, readText: unexpected, writeText: unexpected, mkdir: unexpected, realpath: unexpected, ...overrides }
}
