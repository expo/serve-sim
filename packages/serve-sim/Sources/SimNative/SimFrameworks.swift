import Foundation

enum SimFrameworks {
    struct Attempt: Sendable {
        let path: String
        let error: String?
    }

    struct Report: Sendable {
        let developerDir: String
        let coreSimulator: String?
        let simulatorKit: String?
        let attempts: [Attempt]
    }

    /// Loads the private simulator frameworks (CoreSimulator + SimulatorKit) into
    /// the process.
    ///
    /// These are used purely through the Objective-C runtime (NSClassFromString /
    /// KVC / selectors), never linked or imported, so they're dlopen'd from the
    /// active Xcode rather than declared in Package.swift. That keeps the binary
    /// free of an `@rpath/SimulatorKit` load command whose location is
    /// version-specific — Xcode 27 moved SimulatorKit from
    /// `Developer/Library/PrivateFrameworks` to `Contents/SharedFrameworks`.
    static let report: Report = {
        let dev = Xcode.developerDir()
        // CoreSimulator ships an absolute install name and is also installed
        // system-wide; SimulatorKit lives inside Xcode and moved in 27.
        let coreSimulator = [
            "/Library/Developer/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
            "\(dev)/Library/PrivateFrameworks/CoreSimulator.framework/CoreSimulator",
        ]
        let simulatorKit = [
            "\(dev)/../SharedFrameworks/SimulatorKit.framework/SimulatorKit",       // Xcode 27+
            "\(dev)/Library/PrivateFrameworks/SimulatorKit.framework/SimulatorKit", // Xcode 26 and older
        ]
        var attempts: [Attempt] = []
        func firstLoaded(_ candidates: [String]) -> String? {
            for path in candidates {
                if dlopen(path, RTLD_NOW) != nil {
                    attempts.append(Attempt(path: path, error: nil))
                    return path
                }
                attempts.append(Attempt(path: path, error: dlerror().map { String(cString: $0) } ?? "unknown dlopen error"))
            }
            return nil
        }
        let loadedCoreSimulator = firstLoaded(coreSimulator)
        let loadedSimulatorKit = firstLoaded(simulatorKit)
        return Report(developerDir: dev, coreSimulator: loadedCoreSimulator, simulatorKit: loadedSimulatorKit, attempts: attempts)
    }()

    static func load() throws {
        let report = report
        let missing = [
            report.coreSimulator == nil ? "CoreSimulator" : nil,
            report.simulatorKit == nil ? "SimulatorKit" : nil,
        ].compactMap { $0 }
        guard !missing.isEmpty else { return }
        let tried = report.attempts
            .filter { $0.error != nil }
            .map { "  \($0.path): \($0.error ?? "")" }
            .joined(separator: "\n")
        let fix = report.coreSimulator == nil
            ? "CoreSimulator is installed system-wide by Xcode; run `xcodebuild -runFirstLaunch` to reinstall it."
            : "Check the active Xcode with `xcode-select -p` (or DEVELOPER_DIR). If it is a new Xcode release, report these paths at https://github.com/expo/serve-sim/issues."
        throw NSError(domain: "SimFrameworks", code: 1, userInfo: [NSLocalizedDescriptionKey: """
            serve-sim could not load \(missing.joined(separator: " and ")) (active Xcode: \(report.developerDir)).
            serve-sim loads these private frameworks at runtime, and their location can change between Xcode releases. It tried:
            \(tried)
            \(fix) Then restart serve-sim.
            """])
    }

    static func statusJSON() throws -> String {
        let report = report
        let object: [String: Any] = [
            "developerDir": report.developerDir,
            "coreSimulator": report.coreSimulator ?? NSNull(),
            "simulatorKit": report.simulatorKit ?? NSNull(),
            "attempts": report.attempts.map { ["path": $0.path, "error": $0.error ?? NSNull()] as [String: Any] },
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }
}
