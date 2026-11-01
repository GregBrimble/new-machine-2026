// Runs in the guest's Terminal, using its normal Automation/Accessibility grants.
function run(paths) {
  const current = Application.currentApplication()
  current.includeStandardAdditions = true
  Application("System Settings").activate()
  current.openLocation("x-apple.systempreferences:com.apple.Spotlight-Settings.extension?privacy")
  const process = Application("System Events").processes.byName("System Settings")
  const deadline = Date.now() + 30_000
  let table
  while (!table && Date.now() < deadline) {
    if (process.windows.length) {
      let scope = process.windows[0]
      while (scope.sheets.length) scope = scope.sheets[0]
      const queue = [scope]
      while (queue.length && Date.now() < deadline) {
        const item = queue.shift()
        if (item.role() === "AXTable") {
          table = item
          break
        }
        queue.push(...item.uiElements())
      }
    }
    if (!table) delay(.2)
  }
  if (!table) throw new Error("Could not read the Search Privacy table")
  // This fresh VM has exactly these two exclusions. The table exposes display
  // names, not full paths; exact-path submission is exercised by the initializer.
  const expected = paths.map(path => path.split("/").filter(Boolean).pop()).sort()
  let actual
  do {
    actual = table.rows().map(row => row.textFields[0].value()).sort()
    if (JSON.stringify(actual) === JSON.stringify(expected)) break
    delay(.2)
  } while (Date.now() < deadline)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected Search Privacy rows: ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`)
  }
  Application("System Events").keyCode(36)
  return `PASS: Search Privacy contains ${actual.join(", ")}`
}
