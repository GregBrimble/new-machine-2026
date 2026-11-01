on findControl(wantedRole, wantedLabel)
  set searchDeadline to (current date) + 10
  tell application "System Events"
    tell process "System Settings"
      if not (exists window 1) then return missing value
      set uiContainer to window 1
      repeat while exists sheet 1 of uiContainer
        set uiContainer to sheet 1 of uiContainer
      end repeat
      set controls to {uiContainer}
    end tell
    -- Search shallow controls first, before the folder picker's file listings.
    repeat while (count controls) > 0
      set nextControls to {}
      repeat with uiItem in controls
        if (current date) is greater than or equal to searchDeadline then return missing value
        try
          if role of uiItem is wantedRole then
            set labels to {}
            try
              set end of labels to name of uiItem as text
            end try
            try
              set end of labels to description of uiItem as text
            end try
            try
              set end of labels to value of attribute "AXIdentifier" of uiItem as text
            end try
            repeat with labelText in labels
              if (contents of labelText) is wantedLabel then return contents of uiItem
            end repeat
          end if
          set nextControls to nextControls & (UI elements of uiItem)
        end try
      end repeat
      set controls to nextControls
    end repeat
  end tell
  return missing value
end findControl

on waitForControl(wantedRole, wantedLabel)
  set deadline to (current date) + 30
  repeat
    set uiItem to my findControl(wantedRole, wantedLabel)
    if uiItem is not missing value then return uiItem
    if (current date) is greater than or equal to deadline then exit repeat
    delay 0.2
  end repeat
  error "Could not find " & wantedLabel & ". This automation requires English System Settings on macOS Tahoe."
end waitForControl

on run folderPaths
  tell application "System Events" to set accessible to UI elements enabled
  if not accessible then
    log "Enable Accessibility for your terminal in System Settings. Waiting for permission..."
    open location "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
    set permissionDeadline to (current date) + 300
    repeat
      tell application "System Events" to set accessible to UI elements enabled
      if accessible then exit repeat
      if (current date) is greater than or equal to permissionDeadline then error "Enable Accessibility for your terminal in System Settings > Privacy & Security > Accessibility, then rerun."
      delay 1
    end repeat
  end if
  tell application "System Settings" to activate
  if my findControl("AXTable", "Excluded locations") is missing value then
    open location "x-apple.systempreferences:com.apple.Spotlight-Settings.extension?privacy"
  end if

  repeat with folderPath in folderPaths
    set privacyTable to my waitForControl("AXTable", "Excluded locations")
    tell application "System Events" to set previousCount to count rows of privacyTable
    set addButton to my waitForControl("AXButton", "Add folder or a disk to exclude from indexing.")
    tell application "System Events" to click addButton
    set chooseButton to my waitForControl("AXButton", "OKButton")
    tell application "System Events" to keystroke "g" using {command down, shift down}
    set pathField to my waitForControl("AXTextField", "PathTextField")
    tell application "System Events"
      set value of pathField to contents of folderPath
      key code 36
    end tell
    -- The field belongs to the Go to Folder sheet. Poll its known reference
    -- rather than repeatedly walking the entire picker's accessibility tree.
    set pathDeadline to (current date) + 20
    repeat
      tell application "System Events" to set pathVisible to exists pathField
      if not pathVisible then exit repeat
      if (current date) is greater than or equal to pathDeadline then error "Could not resolve folder: " & folderPath
      delay 0.2
    end repeat
    tell application "System Events" to click chooseButton

    -- Only the innermost sheet is searched, so a picker or error still open
    -- prevents the exclusions table from being accepted as success.
    set privacyTable to my waitForControl("AXTable", "Excluded locations")
    tell application "System Events" to set currentCount to count rows of privacyTable
    if currentCount < previousCount or currentCount > previousCount + 1 then error "Unexpected change to Search Privacy."
  end repeat
  -- Return activates the sheet's default Done button, whose attributed label
  -- is not readable through System Events on Tahoe.
  tell application "System Events" to key code 36
  set closeDeadline to (current date) + 10
  repeat
    tell application "System Events" to tell process "System Settings"
      if not (exists sheet 1 of window 1) then return
    end tell
    if (current date) is greater than or equal to closeDeadline then error "Search Privacy did not close."
    delay 0.2
  end repeat
end run
