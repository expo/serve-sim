import Foundation

// Standalone test: Xcode.swift has no dependency on the N-API addon.
let cases = [
    ("/Applications/Xcode.app/Contents/Developer", "/Applications/Xcode.app/Contents/Developer"),
    (" /Applications/Xcode 27.app/\n", "/Applications/Xcode 27.app/Contents/Developer"),
    ("/Applications/Xcode 26.app", "/Applications/Xcode 26.app/Contents/Developer"),
    ("/Library/Developer/CommandLineTools", "/Library/Developer/CommandLineTools"),
]
for (input, expected) in cases {
    precondition(Xcode.normalizeDeveloperDir(input) == expected, "Failed to normalize \(input)")
}

// xcode-select passes DEVELOPER_DIR through, even when it names an app bundle.
setenv("DEVELOPER_DIR", "/Applications/Xcode 27.app", 1)
precondition(Xcode.developerDir() == "/Applications/Xcode 27.app/Contents/Developer")
setenv("DEVELOPER_DIR", "/Applications/Xcode 26.app/Contents/Developer", 1)
precondition(Xcode.developerDir() == "/Applications/Xcode 26.app/Contents/Developer")
print("Xcode path tests passed (6 checks)")
