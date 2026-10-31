on findControl(wantedRole, wantedLabel)
  tell application "System Events"
    tell process "System Settings"
      if not (exists window 1) then return missing value
      set controls to entire contents of window 1
    end tell
    repeat with uiItem in controls
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
      end try
    end repeat
  end tell
  return missing value
end findControl

on waitForControl(wantedRole, wantedLabel)
  repeat 100 times
    set uiItem to my findControl(wantedRole, wantedLabel)
    if uiItem is not missing value then return uiItem
    delay 0.2
  end repeat
  error "Could not find " & wantedLabel & ". This automation requires English System Settings on macOS Tahoe."
end waitForControl

on run folderPaths
  tell application "System Events"
    if not UI elements enabled then error "Enable Accessibility for your terminal in System Settings > Privacy & Security > Accessibility, then rerun."
  end tell
  tell application "System Settings" to activate
  if my findControl("AXTable", "Excluded locations") is missing value then
    open location "x-apple.systempreferences:com.apple.Spotlight-Settings.extension"
    set privacyButton to my waitForControl("AXButton", "Search Privacy…")
    tell application "System Events" to click privacyButton
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
    -- Wait for Go to Folder to close before submitting the open panel.
    repeat 100 times
      if my findControl("AXTextField", "PathTextField") is missing value then exit repeat
      delay 0.2
    end repeat
    if my findControl("AXTextField", "PathTextField") is not missing value then error "Could not resolve folder: " & folderPath
    set chooseButton to my waitForControl("AXButton", "OKButton")
    tell application "System Events" to click chooseButton

    -- An error dialog or an open picker must never be reported as success.
    set focusedOnTable to false
    repeat 100 times
      tell application "System Events"
        try
          set focusedControl to value of attribute "AXFocusedUIElement" of process "System Settings"
          if role of focusedControl is "AXTable" and name of focusedControl is "Excluded locations" then set focusedOnTable to true
        end try
      end tell
      if focusedOnTable then exit repeat
      delay 0.2
    end repeat
    if not focusedOnTable then error "Search Privacy did not accept folder: " & folderPath
    set privacyTable to my waitForControl("AXTable", "Excluded locations")
    tell application "System Events" to set currentCount to count rows of privacyTable
    if currentCount < previousCount or currentCount > previousCount + 1 then error "Unexpected change to Search Privacy."
  end repeat
  set doneButton to my waitForControl("AXButton", "Done")
  tell application "System Events" to click doneButton
end run
