import Cocoa
import Virtualization
import IOKit
import IOKit.usb

// MARK: - Helpers

func log(_ msg: String) { fputs("\(msg)\n", stderr) }

func die(_ msg: String) -> Never { log("Error: \(msg)"); exit(1) }

let GB: UInt64 = 1_073_741_824

/// Block on an async callback-based API, keeping the run loop alive.
func waitFor<T>(_ work: (@escaping (Result<T, Error>) -> Void) -> Void) throws -> T {
    let sem = DispatchSemaphore(value: 0)
    var result: Result<T, Error>!
    work { r in result = r; sem.signal() }
    while sem.wait(timeout: .now()) == .timedOut {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.5))
    }
    return try result.get()
}

// MARK: - VM Bundle (directory layout)

struct VMBundle {
    let url: URL

    var disk: URL            { url.appending(path: "Disk.img") }
    var auxStorage: URL      { url.appending(path: "AuxiliaryStorage") }
    var hardwareModel: URL   { url.appending(path: "HardwareModel") }
    var machineId: URL       { url.appending(path: "MachineIdentifier") }
    var configJSON: URL      { url.appending(path: "config.json") }
    var legacyPlist: URL     { url.appending(path: ".vbdata/Config.plist") }
    var name: String         { url.deletingPathExtension().lastPathComponent }

    func loadHardwareModel() throws -> VZMacHardwareModel {
        let data = try Data(contentsOf: hardwareModel)
        guard let m = VZMacHardwareModel(dataRepresentation: data), m.isSupported else {
            die("unsupported or invalid HardwareModel")
        }
        return m
    }

    func loadMachineId() throws -> VZMacMachineIdentifier {
        let data = try Data(contentsOf: machineId)
        guard let m = VZMacMachineIdentifier(dataRepresentation: data) else {
            die("invalid MachineIdentifier")
        }
        return m
    }

    func loadAuxStorage() -> VZMacAuxiliaryStorage {
        VZMacAuxiliaryStorage(contentsOf: auxStorage)
    }
}

// MARK: - VM Config (JSON-serializable settings)

struct VMConfig {
    var cpus       = 4
    var memoryGB   = 4
    var diskGB     = 64
    var width      = 1920
    var height     = 1200
    var ppi        = 144
    var mac        = ""
    var noAudio    = false
    var noAccel    = false
    var noFairPlay = false
    var network    = "nat"         // "nat" or "bridge[=<interface>]"
    var usbDevices: [String] = []  // vendor:product hex pairs, e.g. "05ac:12ab"

    var memorySize: UInt64 { UInt64(memoryGB) * GB }

    // Load: config.json -> legacy plist -> defaults
    static func load(from bundle: VMBundle) -> VMConfig {
        if let c = try? loadJSON(bundle.configJSON) { return c }
        if let c = try? loadPlist(bundle.legacyPlist) { return c }
        return VMConfig()
    }

    private static func loadJSON(_ url: URL) throws -> VMConfig {
        let j = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] ?? [:]
        var c = VMConfig()
        if let v = j["cpuCount"]      as? Int    { c.cpus     = v }
        if let v = j["memoryGB"]      as? Int    { c.memoryGB = v }
        if let v = j["diskSizeGB"]    as? Int    { c.diskGB   = v }
        if let v = j["displayWidth"]  as? Int    { c.width    = v }
        if let v = j["displayHeight"] as? Int    { c.height   = v }
        if let v = j["pixelsPerInch"] as? Int    { c.ppi      = v }
        if let v = j["macAddress"]    as? String { c.mac      = v }
        if let v = j["noAudio"]       as? Bool   { c.noAudio  = v }
        if let v = j["noAccel"]       as? Bool   { c.noAccel  = v }
        if let v = j["noFairPlay"]    as? Bool   { c.noFairPlay = v }
        if let v = j["network"]       as? String { c.network   = v }
        return c
    }

    private static func loadPlist(_ url: URL) throws -> VMConfig {
        let plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil)
        guard let hw = (plist as? [String: Any])?["hardware"] as? [String: Any] else { throw CocoaError(.fileReadCorruptFile) }
        var c = VMConfig()
        c.cpus = hw["cpuCount"] as? Int ?? c.cpus
        if let b = hw["memorySize"]    as? UInt64          { c.memoryGB = Int(b / GB) }
        if let d = (hw["displayDevices"]  as? [[String: Any]])?.first {
            c.width  = d["width"]         as? Int ?? c.width
            c.height = d["height"]        as? Int ?? c.height
            c.ppi    = d["pixelsPerInch"] as? Int ?? c.ppi
        }
        if let n = (hw["networkDevices"]  as? [[String: Any]])?.first { c.mac = n["macAddress"] as? String ?? "" }
        if let s =  hw["soundDevices"]    as? [[String: Any]]         { c.noAudio = s.isEmpty }
        return c
    }

    func save(to url: URL) throws {
        var d: [String: Any] = [
            "cpuCount": cpus, "memoryGB": memoryGB, "diskSizeGB": diskGB,
            "displayWidth": width, "displayHeight": height, "pixelsPerInch": ppi,
        ]
        if !mac.isEmpty { d["macAddress"] = mac }
        if noAudio { d["noAudio"] = true }
        if noAccel { d["noAccel"] = true }
        if noFairPlay { d["noFairPlay"] = true }
        if network != "nat" { d["network"] = network }
        try JSONSerialization.data(withJSONObject: d, options: [.prettyPrinted, .sortedKeys]).write(to: url)
    }
}

// MARK: - Build VZVirtualMachineConfiguration

func setPlatformBool(_ obj: NSObject, setter: String, value: Bool) {
    let sel = NSSelectorFromString(setter)
    guard obj.responds(to: sel) else { return }
    typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
    unsafeBitCast(obj.method(for: sel), to: SetBool.self)(obj, sel, value)
}

func setPlatformU64(_ obj: NSObject, setter: String, value: UInt64) {
    let sel = NSSelectorFromString(setter)
    guard obj.responds(to: sel) else { return }
    typealias SetU64 = @convention(c) (AnyObject, Selector, UInt64) -> Void
    unsafeBitCast(obj.method(for: sel), to: SetU64.self)(obj, sel, value)
}

func enableFairPlay(_ platform: VZMacPlatformConfiguration) {
    // FairPlay: works via KVC
    if (platform as NSObject).responds(to: NSSelectorFromString("_isFairPlayEnabled")) {
        platform.setValue(true, forKey: "_fairPlayEnabled")
        log("  FairPlay: enabled")
    }

    // Strong Identity
    setPlatformBool(platform, setter: "_setStrongIdentityEnabled:", value: true)
    log("  StrongIdentity: enabled")

    // Disable fake encryption (enable real encryption for attestation)
    setPlatformBool(platform, setter: "_setFakeEncryptionEnabled:", value: false)
    log("  FakeEncryption: disabled")

    // SIO Descrambler
    setPlatformBool(platform, setter: "_setSIODescramblerEnabled:", value: true)
    log("  SIODescrambler: enabled")

    // Host attribute share options (share all attributes)
    setPlatformU64(platform, setter: "_setHostAttributeShareOptions:", value: 0xFF)
    log("  HostAttributeShareOptions: 0xFF")
}

func attachBiometricDevice(_ vz: VZVirtualMachineConfiguration) {
    if let cls = NSClassFromString("_VZMacTouchIDDeviceConfiguration") as? NSObject.Type {
        let device = cls.init()
        vz.setValue([device], forKey: "_biometricDevices")
        log("  Biometric: TouchID")
    }
}

// MARK: - USB Passthrough

/// Parse "05ac:12ab" into (vendorID, productID)
func parseUSBID(_ s: String) -> (Int, Int)? {
    let parts = s.split(separator: ":")
    guard parts.count == 2,
          let vid = Int(parts[0], radix: 16),
          let pid = Int(parts[1], radix: 16) else { return nil }
    return (vid, pid)
}

/// Look up the IOKit locationID for a USB device by vendor:product ID.
func findUSBLocationID(vendorID: Int, productID: Int) -> UInt32? {
    let matching = IOServiceMatching("IOUSBHostDevice") as NSMutableDictionary
    matching["idVendor"] = vendorID
    matching["idProduct"] = productID

    var iterator: io_iterator_t = 0
    let kr = IOServiceGetMatchingServices(kIOMainPortDefault, matching, &iterator)
    guard kr == KERN_SUCCESS else { return nil }
    defer { IOObjectRelease(iterator) }

    let service = IOIteratorNext(iterator)
    guard service != 0 else { return nil }
    defer { IOObjectRelease(service) }

    var props: Unmanaged<CFMutableDictionary>?
    IORegistryEntryCreateCFProperties(service, &props, kCFAllocatorDefault, 0)
    guard let dict = props?.takeRetainedValue() as? [String: Any],
          let locID = dict["locationID"] as? UInt32 else { return nil }
    return locID
}

/// Create a _VZIOUSBHostPassthroughDeviceConfiguration via +fromLocationID:error:
func makeUSBPassthroughConfig(locationID: UInt32) -> NSObject? {
    guard let cls = NSClassFromString("_VZIOUSBHostPassthroughDeviceConfiguration") else {
        log("  USB: _VZIOUSBHostPassthroughDeviceConfiguration not available")
        return nil
    }

    let sel = NSSelectorFromString("fromLocationID:error:")
    guard (cls as AnyObject).responds(to: sel) else {
        log("  USB: fromLocationID:error: not available")
        return nil
    }

    var error: NSError?
    typealias FactoryMethod = @convention(c) (AnyObject, Selector, UInt32, UnsafeMutablePointer<NSError?>) -> AnyObject?
    let imp = (cls as AnyObject).method(for: sel)
    let fn = unsafeBitCast(imp, to: FactoryMethod.self)
    let result = fn(cls as AnyObject, sel, locationID, &error)

    if let error = error {
        log("  USB: fromLocationID failed: \(error.localizedDescription)")
        return nil
    }

    return result as? NSObject
}

/// Build passthrough device configs for all requested USB devices.
/// Returns VZUSBDeviceConfiguration objects to add to VZXHCIControllerConfiguration.usbDevices.
func buildUSBPassthroughConfigs(_ usbIDs: [String]) -> [NSObject] {
    var configs: [NSObject] = []
    for usbID in usbIDs {
        guard let (vid, pid) = parseUSBID(usbID) else {
            log("  USB: invalid ID '\(usbID)'")
            continue
        }
        guard let locID = findUSBLocationID(vendorID: vid, productID: pid) else {
            log("  USB: device \(usbID) not found on host")
            continue
        }
        log("  USB: \(usbID) locationID=0x\(String(locID, radix: 16))")

        guard let devConfig = makeUSBPassthroughConfig(locationID: locID) else {
            continue
        }
        configs.append(devConfig)
    }
    return configs
}

// MARK: - Network

/// Build a VZNetworkDeviceAttachment for the given network mode string.
/// "nat" -> VZNATNetworkDeviceAttachment
/// "bridge" -> VZBridgedNetworkDeviceAttachment (auto-picks first suitable interface)
/// "bridge=en0" -> VZBridgedNetworkDeviceAttachment with the named interface
func makeNetworkAttachment(_ mode: String) -> VZNetworkDeviceAttachment {
    if mode == "nat" { return VZNATNetworkDeviceAttachment() }

    guard mode.hasPrefix("bridge") else {
        die("unknown network mode '\(mode)' (expected 'nat' or 'bridge[=<interface>]')")
    }

    // Parse optional "=<interface>" suffix
    let requestedIface: String?
    if let eqIdx = mode.firstIndex(of: "=") {
        requestedIface = String(mode[mode.index(after: eqIdx)...])
    } else {
        requestedIface = nil
    }

    let interfaces = VZBridgedNetworkInterface.networkInterfaces
    guard !interfaces.isEmpty else {
        die("no bridged network interfaces available on this host")
    }

    let iface: VZBridgedNetworkInterface
    if let name = requestedIface {
        guard let found = interfaces.first(where: { $0.identifier == name }) else {
            let available = interfaces.map { $0.identifier }.joined(separator: ", ")
            die("bridge interface '\(name)' not found (available: \(available))")
        }
        iface = found
    } else {
        // Auto-pick: prefer en0, then first available
        iface = interfaces.first(where: { $0.identifier == "en0" }) ?? interfaces[0]
    }

    log("  Network: bridge via \(iface.identifier) (\(iface.localizedDisplayName ?? "unknown"))")
    return VZBridgedNetworkDeviceAttachment(interface: iface)
}

func buildVMConfig(bundle: VMBundle, config: VMConfig) throws -> VZVirtualMachineConfiguration {
    let vz = VZVirtualMachineConfiguration()

    // Platform
    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel    = try bundle.loadHardwareModel()
    platform.machineIdentifier = try bundle.loadMachineId()
    platform.auxiliaryStorage  = bundle.loadAuxStorage()
    if !config.noFairPlay { enableFairPlay(platform) }
    vz.platform   = platform
    vz.bootLoader = VZMacOSBootLoader()
    vz.cpuCount   = config.cpus
    vz.memorySize = config.memorySize

    // Display (always attached -- macOS needs a framebuffer even in headless mode)
    let gfx = VZMacGraphicsDeviceConfiguration()
    gfx.displays = [VZMacGraphicsDisplayConfiguration(
        widthInPixels: config.width, heightInPixels: config.height, pixelsPerInch: config.ppi
    )]
    vz.graphicsDevices = [gfx]

    // Disk
    vz.storageDevices = [VZVirtioBlockDeviceConfiguration(
        attachment: try VZDiskImageStorageDeviceAttachment(url: bundle.disk, readOnly: false)
    )]

    // Network
    let net = VZVirtioNetworkDeviceConfiguration()
    net.macAddress = VZMACAddress(string: config.mac) ?? .randomLocallyAdministered()
    net.attachment = makeNetworkAttachment(config.network)
    if config.network == "nat" { log("  Network: NAT") }
    vz.networkDevices = [net]

    // Input
    vz.keyboards      = [VZUSBKeyboardConfiguration()]
    vz.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]

    // Audio
    if !config.noAudio {
        let audio = VZVirtioSoundDeviceConfiguration()
        let input  = VZVirtioSoundDeviceInputStreamConfiguration();  input.source  = VZHostAudioInputStreamSource()
        let output = VZVirtioSoundDeviceOutputStreamConfiguration(); output.sink = VZHostAudioOutputStreamSink()
        audio.streams = [input, output]
        vz.audioDevices = [audio]
    }

    vz.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

    // Private API: VideoToolbox + M2Scaler paravirtualization
    if !config.noAccel {
        let classes = ["_VZMacVideoToolboxDeviceConfiguration", "_VZMacScalerAcceleratorDeviceConfiguration"]
        let accels = classes.compactMap { NSClassFromString($0) as? NSObject.Type }.map { $0.init() }
        if !accels.isEmpty {
            vz.setValue(accels, forKey: "_acceleratorDevices")
            log("  Accelerators: VideoToolbox, M2Scaler")
        }
    }

    // Private API: Biometric (TouchID) device for attestation
    if !config.noFairPlay { attachBiometricDevice(vz) }

    // USB Passthrough: add empty XHCI controller.
    // Device attachment happens at runtime after VM starts (see captureUSBDevices).
    if !config.usbDevices.isEmpty {
        vz.usbControllers = [VZXHCIControllerConfiguration()]
        log("  USB: XHCI controller added")
    }

    do {
        try vz.validate()
    } catch {
        let ns = error as NSError
        log("Validation failed: \(ns.localizedDescription)")
        if let reason = ns.userInfo[NSLocalizedFailureReasonErrorKey] as? String {
            log("  Reason: \(reason)")
        }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            log("  Underlying: \(underlying.domain) \(underlying.code) - \(underlying.localizedDescription)")
        }
        throw error
    }

    return vz
}

// Variant for install: takes raw hardware model + aux storage instead of loading from bundle files
func buildInstallVMConfig(hardwareModel: VZMacHardwareModel, machineId: VZMacMachineIdentifier,
                          auxStorage: VZMacAuxiliaryStorage, diskURL: URL, config: VMConfig) throws -> VZVirtualMachineConfiguration {
    let vz = VZVirtualMachineConfiguration()

    let platform = VZMacPlatformConfiguration()
    platform.hardwareModel     = hardwareModel
    platform.machineIdentifier = machineId
    platform.auxiliaryStorage  = auxStorage
    if !config.noFairPlay { enableFairPlay(platform) }
    vz.platform   = platform
    vz.bootLoader = VZMacOSBootLoader()
    vz.cpuCount   = config.cpus
    vz.memorySize = config.memorySize

    let gfx = VZMacGraphicsDeviceConfiguration()
    gfx.displays = [VZMacGraphicsDisplayConfiguration(
        widthInPixels: config.width, heightInPixels: config.height, pixelsPerInch: config.ppi
    )]
    vz.graphicsDevices = [gfx]

    vz.storageDevices = [VZVirtioBlockDeviceConfiguration(
        attachment: try VZDiskImageStorageDeviceAttachment(url: diskURL, readOnly: false)
    )]

    let net = VZVirtioNetworkDeviceConfiguration()
    net.macAddress = VZMACAddress(string: config.mac) ?? .randomLocallyAdministered()
    net.attachment = makeNetworkAttachment(config.network)
    vz.networkDevices = [net]

    vz.keyboards       = [VZUSBKeyboardConfiguration()]
    vz.pointingDevices = [VZUSBScreenCoordinatePointingDeviceConfiguration()]
    vz.entropyDevices  = [VZVirtioEntropyDeviceConfiguration()]

    if !config.noAudio {
        let audio  = VZVirtioSoundDeviceConfiguration()
        let output = VZVirtioSoundDeviceOutputStreamConfiguration(); output.sink = VZHostAudioOutputStreamSink()
        audio.streams = [output]
        vz.audioDevices = [audio]
    }

    try vz.validate()
    return vz
}

// MARK: - Install

func resolveIPSW(_ path: String, near bundlePath: String) -> URL {
    if path != "latest" {
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: url.path) else { die("IPSW not found at '\(path)'") }
        return url
    }

    log("Fetching latest supported IPSW info...")
    let image: VZMacOSRestoreImage = try! waitFor { cb in VZMacOSRestoreImage.fetchLatestSupported { cb($0) } }
    let dest  = URL(fileURLWithPath: bundlePath).deletingLastPathComponent().appendingPathComponent(image.url.lastPathComponent)

    if FileManager.default.fileExists(atPath: dest.path) {
        log("IPSW already downloaded: \(dest.path)")
        return dest
    }

    log("Downloading: \(image.url)")
    let task = URLSession.shared.downloadTask(with: image.url) { tmp, _, err in
        if let err { die("Download failed: \(err.localizedDescription)") }
        try! FileManager.default.moveItem(at: tmp!, to: dest)
    }
    task.resume()
    var lastPct = -1
    while task.state == URLSessionTask.State.running {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 1.0))
        let recv = task.countOfBytesReceived, total = task.countOfBytesExpectedToReceive
        if total > 0 {
            let pct = Int(recv * 100 / total)
            if pct != lastPct {
                fputs("\r  \(pct)%  \(String(format: "%.1f/%.1f GB", Double(recv) / 1e9, Double(total) / 1e9))   ", stderr)
                lastPct = pct
            }
        }
    }
    fputs("\n", stderr)
    log("Download complete.")
    return dest
}

func install(ipswPath: String, bundlePath: String, config: VMConfig) {
    let fm = FileManager.default
    guard !fm.fileExists(atPath: bundlePath) else {
        die("'\(bundlePath)' already exists. Remove it first or choose a different path.")
    }

    // Resolve IPSW (download if "latest")
    let ipswURL = resolveIPSW(ipswPath, near: bundlePath)

    // Load restore image metadata
    log("Loading IPSW: \(ipswURL.lastPathComponent)")
    let image: VZMacOSRestoreImage = try! waitFor { cb in VZMacOSRestoreImage.load(from: ipswURL) { cb($0) } }
    guard let reqs = image.mostFeaturefulSupportedConfiguration else { die("IPSW not supported on this host") }

    let hwModel = reqs.hardwareModel
    log("  Build: \(image.buildVersion)")
    log("  Min CPUs: \(reqs.minimumSupportedCPUCount), Min RAM: \(reqs.minimumSupportedMemorySize / GB) GB")

    // Clamp config to IPSW minimums
    var cfg = config
    if cfg.cpus     < reqs.minimumSupportedCPUCount { cfg.cpus     = reqs.minimumSupportedCPUCount }
    if cfg.memoryGB < Int(reqs.minimumSupportedMemorySize / GB) { cfg.memoryGB = Int(reqs.minimumSupportedMemorySize / GB) }
    if cfg.mac.isEmpty { cfg.mac = VZMACAddress.randomLocallyAdministered().string }

    // Create bundle directory and contents
    let bundle = VMBundle(url: URL(fileURLWithPath: bundlePath))
    try! fm.createDirectory(at: bundle.url, withIntermediateDirectories: true)
    try! hwModel.dataRepresentation.write(to: bundle.hardwareModel)
    let mid = VZMacMachineIdentifier()
    try! mid.dataRepresentation.write(to: bundle.machineId)
    let aux = try! VZMacAuxiliaryStorage(creatingStorageAt: bundle.auxStorage, hardwareModel: hwModel, options: [.allowOverwrite])
    fm.createFile(atPath: bundle.disk.path, contents: nil)
    try! FileHandle(forWritingTo: bundle.disk).apply { try $0.truncate(atOffset: UInt64(cfg.diskGB) * GB); try $0.close() }
    try! cfg.save(to: bundle.configJSON)

    log("  Created bundle: \(bundlePath)")
    log("  CPUs: \(cfg.cpus), RAM: \(cfg.memoryGB) GB, Disk: \(cfg.diskGB) GB")

    // Build VM config and install
    let vmConfig = try! buildInstallVMConfig(hardwareModel: hwModel, machineId: mid, auxStorage: aux, diskURL: bundle.disk, config: cfg)
    let vm = VZVirtualMachine(configuration: vmConfig)

    log("Installing macOS (this will take a while)...")
    let installer = VZMacOSInstaller(virtualMachine: vm, restoringFromImageAt: ipswURL)
    let obs = installer.progress.observe(\.fractionCompleted, options: []) { (p: Progress, _) in
        fputs("\r  Install progress: \(Int(p.fractionCompleted * 100))%    ", stderr)
    }

    let sem = DispatchSemaphore(value: 0)
    var installErr: Error?
    installer.install { result in
        if case .failure(let e) = result { installErr = e }
        sem.signal()
    }
    while sem.wait(timeout: .now()) == .timedOut { RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.5)) }
    _ = obs; fputs("\n", stderr)

    if let e = installErr {
        let ns = e as NSError
        log("  Domain: \(ns.domain), Code: \(ns.code)")
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            log("  Underlying: \(underlying.domain) \(underlying.code) - \(underlying.localizedDescription)")
        }
        die("Install failed: \(e.localizedDescription)")
    }
    log("macOS installed successfully!")
    log("Run with:  avm \(bundlePath)")
    exit(0)
}

// MARK: - Run

class VMDelegate: NSObject, VZVirtualMachineDelegate {
    func virtualMachine(_ vm: VZVirtualMachine, didStopWithError error: Error) { log("VM stopped: \(error.localizedDescription)"); exit(1) }
    func guestDidStop(_ vm: VZVirtualMachine) { log("Guest shut down."); exit(0) }
}

class VMWindow: NSObject, NSWindowDelegate {
    let window: NSWindow
    let view: VZVirtualMachineView

    init(vm: VZVirtualMachine, title: String, width: Int, height: Int) {
        view = VZVirtualMachineView()
        view.virtualMachine = vm
        view.capturesSystemKeys = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: CGFloat(width) / 2, height: CGFloat(height) / 2),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = title
        window.contentView = view
        window.contentMinSize = NSSize(width: 640, height: 480)
        super.init()
        window.delegate = self
        window.center()
        window.makeKeyAndOrderFront(nil)
    }

    func windowWillClose(_ n: Notification) { exit(0) }
}

class AppDelegate: NSObject, NSApplicationDelegate {
    let bundle: VMBundle, config: VMConfig, headless: Bool, recovery: Bool
    var delegate: VMDelegate?
    var window: VMWindow?

    init(bundle: VMBundle, config: VMConfig, headless: Bool, recovery: Bool) {
        self.bundle = bundle; self.config = config; self.headless = headless; self.recovery = recovery
    }

    func applicationDidFinishLaunching(_ n: Notification) {
        do {
            log("VM: \(bundle.name)")
            log("  CPUs: \(config.cpus), RAM: \(config.memoryGB) GB")
            log("  Display: \(config.width)x\(config.height) @ \(config.ppi) PPI")
            log("  Mode: \(headless ? "headless" : "GUI")\(recovery ? " (recovery)" : "")")

            let vmConfig = try buildVMConfig(bundle: bundle, config: config)
            let vm = VZVirtualMachine(configuration: vmConfig)
            delegate = VMDelegate(); vm.delegate = delegate

            if headless {
                // Attach a VZVirtualMachineView even in headless mode -- without it,
                // Virtualization.framework doesn't create the NAT bridge (bridge100)
                let view = VZVirtualMachineView()
                view.virtualMachine = vm
                objc_setAssociatedObject(vm, "headlessView", view, .OBJC_ASSOCIATION_RETAIN)
            } else {
                window = VMWindow(vm: vm, title: bundle.name, width: config.width, height: config.height)
            }

            log("Starting...")
            if recovery {
                let opts = VZMacOSVirtualMachineStartOptions(); opts.startUpFromMacOSRecovery = true
                vm.start(options: opts) { [self] err in
                    if let e = err { die("Failed to start: \(e.localizedDescription)") }
                    log("VM running (recovery).")
                    self.captureUSBDevices(from: vm)
                }
            } else {
                vm.start { [self] r in
                    if case .failure(let e) = r { die("Failed to start: \(e.localizedDescription)") }
                    log("VM running.")
                    self.captureUSBDevices(from: vm)
                }
            }
        } catch { die(error.localizedDescription) }
    }

    func captureUSBDevices(from vm: VZVirtualMachine) {
        guard !config.usbDevices.isEmpty else { return }
        guard let controller = vm.usbControllers.first else {
            log("  USB: no XHCI controller on running VM")
            return
        }

        // Build passthrough configs and create runtime devices, then attach + capture.
        let usbConfigs = buildUSBPassthroughConfigs(config.usbDevices)
        guard !usbConfigs.isEmpty else {
            log("  USB: no valid passthrough configs")
            return
        }

        // Create runtime _VZIOUSBHostPassthroughDevice from each config
        guard let devCls = NSClassFromString("_VZIOUSBHostPassthroughDevice") as? NSObject.Type else {
            log("  USB: _VZIOUSBHostPassthroughDevice not available")
            return
        }

        let initSel = NSSelectorFromString("initWithConfiguration:error:")
        guard devCls.instancesRespond(to: initSel) else {
            log("  USB: initWithConfiguration:error: not available")
            return
        }

        typealias InitMethod = @convention(c) (AnyObject, Selector, AnyObject, UnsafeMutablePointer<NSError?>) -> AnyObject?
        let initImp = devCls.instanceMethod(for: initSel)!
        let initFn = unsafeBitCast(initImp, to: InitMethod.self)

        var devices: [NSObject] = []
        for cfg in usbConfigs {
            let obj = devCls.init()
            var err: NSError?
            if let dev = initFn(obj, initSel, cfg, &err) as? NSObject {
                devices.append(dev)
                log("  USB: device created from config")
            } else {
                log("  USB: device init failed: \(err?.localizedDescription ?? "unknown")")
            }
        }

        guard !devices.isEmpty else {
            log("  USB: no runtime devices created")
            return
        }

        // Attach each device to the XHCI controller, then capture
        let group = DispatchGroup()
        for dev in devices {
            group.enter()
            controller.attach(device: dev as! VZUSBDevice) { error in
                if let e = error {
                    log("  USB: attach failed: \(e.localizedDescription)")
                } else {
                    log("  USB: device attached")
                }
                group.leave()
            }
        }

        group.notify(queue: .main) {
            // After all devices attached, capture passthrough devices from host
            let captureSel = NSSelectorFromString("_capturePassthroughDevicesWithCompletionHandler:")
            guard (controller as NSObject).responds(to: captureSel) else {
                log("  USB: _capturePassthroughDevices not available")
                return
            }

            // Note: type encoding shows ^v (raw pointer) for the handler parameter,
            // but ObjC runtime accepts blocks as void* transparently.
            typealias CaptureMethod = @convention(c) (AnyObject, Selector, @escaping @convention(block) (NSError?) -> Void) -> Void
            let imp = (controller as NSObject).method(for: captureSel)
            let fn = unsafeBitCast(imp, to: CaptureMethod.self)
            fn(controller, captureSel) { error in
                if let e = error {
                    log("  USB: capture failed: \(e.localizedDescription)")
                } else {
                    log("  USB: passthrough devices captured from host")
                }
            }
        }
    }
}

// MARK: - CLI

let usage = """
avm - macOS VM manager using Virtualization.framework

USAGE:
  avm <path.vbvm>                          Run an existing VM
  avm install <ipsw|latest> <path.vbvm>    Create and install a new VM

OPTIONS:
  --headless       Run without GUI window      --recovery       Boot into macOS Recovery
  --cpus <n>       CPU count (default: 4)      --memory <n>     RAM in GB (default: 4)
  --disk <n>       Disk size in GB (default: 64, install only)
  --display <WxH>  Resolution (default: 1920x1200)
  --net <mode>     Network: nat (default), bridge, bridge=<iface>
  --no-accel       Disable VideoToolbox/M2Scaler paravirtualization
  --no-audio       Disable audio
  --no-fairplay    Disable FairPlay DRM paravirtualization
  --usb <vid:pid>  Pass through USB device (hex, e.g. 05ac:12ab). Repeatable.

EXAMPLES:
  avm install latest ~/VMs/dev.vbvm --cpus 6 --memory 8 --disk 128
  avm ~/VMs/dev.vbvm --net bridge
  avm ~/VMs/dev.vbvm --net bridge=en0
  avm --headless --recovery ~/VMs/dev.vbvm
"""

var args = Array(CommandLine.arguments.dropFirst())
if args.isEmpty || args.contains("-h") || args.contains("--help") { fputs(usage + "\n", stderr); exit(0) }

let isInstall = args.first == "install"
if isInstall { args.removeFirst() }

var headless = false, recovery = false
var config = VMConfig()
var positional: [String] = []

var i = 0
while i < args.count {
    switch args[i] {
    case "--headless":  headless = true
    case "--recovery":  recovery = true
    case "--no-accel":  config.noAccel = true
    case "--no-audio":  config.noAudio = true
    case "--no-fairplay": config.noFairPlay = true
    case "--net":       i += 1; guard i < args.count else { die("--net needs mode (nat, bridge, bridge=<iface>)") }; config.network = args[i]
    case "--usb":       i += 1; guard i < args.count else { die("--usb needs vid:pid") }; config.usbDevices.append(args[i])
    case "--cpus":      i += 1; guard i < args.count, let v = Int(args[i]), v > 0 else { die("--cpus needs positive int") }; config.cpus = v
    case "--memory":    i += 1; guard i < args.count, let v = Int(args[i]), v > 0 else { die("--memory needs positive int") }; config.memoryGB = v
    case "--disk":      i += 1; guard i < args.count, let v = Int(args[i]), v > 0 else { die("--disk needs positive int") }; config.diskGB = v
    case "--display":
        i += 1; guard i < args.count else { die("--display needs WxH") }
        let p = args[i].lowercased().split(separator: "x")
        guard p.count == 2, let w = Int(p[0]), let h = Int(p[1]), w > 0, h > 0 else { die("--display format: WxH") }
        config.width = w; config.height = h
    default:
        if args[i].hasPrefix("-") { die("unknown option '\(args[i])'") }
        positional.append(args[i])
    }
    i += 1
}

if isInstall {
    guard positional.count == 2 else { die("install needs <ipsw|latest> <bundle-path>") }
    install(ipswPath: positional[0], bundlePath: positional[1], config: config)
    dispatchMain()
} else {
    guard positional.count == 1 else { die("expected one VM bundle path") }
    let path = positional[0]
    guard FileManager.default.fileExists(atPath: path) else { die("'\(path)' does not exist") }

    let bundle = VMBundle(url: URL(fileURLWithPath: path))
    var cfg = VMConfig.load(from: bundle)

    // CLI overrides
    if args.contains("--cpus")    { cfg.cpus   = config.cpus }
    if args.contains("--memory")  { cfg.memoryGB = config.memoryGB }
    if args.contains("--display") { cfg.width  = config.width; cfg.height = config.height }
    if args.contains("--no-audio") { cfg.noAudio = true }
    if args.contains("--no-accel") { cfg.noAccel = true }
    if args.contains("--no-fairplay") { cfg.noFairPlay = true }
    if args.contains("--net") { cfg.network = config.network }
    if !config.usbDevices.isEmpty { cfg.usbDevices = config.usbDevices }

    let app = NSApplication.shared
    let appDelegate = AppDelegate(bundle: bundle, config: cfg, headless: headless, recovery: recovery)
    app.delegate = appDelegate
    // .prohibited prevents Virtualization.framework from creating the NAT bridge;
    // .accessory keeps AppKit alive without showing a Dock icon or menu bar
    app.setActivationPolicy(headless ? .accessory : .regular)
    if !headless { app.activate(ignoringOtherApps: true) }
    app.run()
}

// MARK: - Extensions

extension FileHandle {
    @discardableResult func apply(_ body: (FileHandle) throws -> Void) rethrows -> FileHandle { try body(self); return self }
}
