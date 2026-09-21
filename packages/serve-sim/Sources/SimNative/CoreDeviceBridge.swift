import Foundation
import CoreDeviceShim
import StreamingPolicy

/// A narrow adapter for CoreDevice's private Swift API. Apple does not ship its
/// module interface, so the C target preserves the ABI through guarded symbol
/// trampolines. No private symbol is a load-time dependency of the Node addon.
actor CoreDeviceBridge {
    static let shared = CoreDeviceBridge()

    enum BridgeError: Error { case unavailable, deviceUnavailable, initializationTimedOut }

    private var manager: CoreDeviceManagerObject?
    private let managerReadiness = SharedReadiness()
    private var capabilities: [String: CoreDeviceCapabilityObject] = [:]
    private var hingeSupport: [String: Bool] = [:]

    func remoteDevice(udid: String) async throws -> CoreDeviceRemoteDevice {
        guard SSCoreDeviceInitialize() else { throw BridgeError.unavailable }
        if manager == nil {
            // Initializes resilient class metadata and field offsets before
            // using the class metadata's allocating initializer.
            _ = coreDeviceSharedManager()
            guard let managerMetadata = SSCoreDeviceSymbol("$s10CoreDevice0B7ManagerCN"),
                  let visibilityMetadata = SSCoreDeviceSymbol("$s10CoreDevice0B15VisibilityClassON"),
                  let visibilityType = unsafeBitCast(visibilityMetadata, to: Any.Type.self) as? any Hashable.Type
            else { throw BridgeError.unavailable }
            let managerType = unsafeBitCast(managerMetadata, to: CoreDeviceManagerObject.Type.self)
            let visibilitySet = Self.makeVisibilitySet(visibilityType)
            manager = withExtendedLifetime(visibilitySet) {
                let rawSet = withUnsafePointer(to: visibilitySet) {
                    UnsafeRawPointer($0).load(as: UnsafeMutableRawPointer.self)
                }
                // The private initializer consumes the Set. Keep the original
                // Any-owned value alive until initialization has completed.
                SSCoreDeviceRetainBridgeObject(rawSet)
                return managerType.create(connection: coreDeviceServiceConnection(), allowed: rawSet)
            }
        }
        guard let manager else { throw BridgeError.unavailable }
        do {
            try await managerReadiness.waitUntilReady {
                await self.managerIsInitialized()
            }
        } catch SharedReadiness.Failure.timedOut {
            throw BridgeError.initializationTimedOut
        }
        guard let device = manager.allDevices().first(where: { $0.identifier().uuidString.caseInsensitiveCompare(udid) == .orderedSame })
        else { throw BridgeError.deviceUnavailable }
        return device
    }

    private func managerIsInitialized() -> Bool {
        manager?.initialized() == true
    }

    private static func makeVisibilitySet<T: Hashable>(_: T.Type) -> Any {
        // Open Apple's actual enum type, using its allCases getter rather than
        // constructing enum tags or hashing a substitute Swift type.
        let cases = unsafeBitCast(coreDeviceVisibilityAllCases(), to: [T].self)
        return Set(cases)
    }

    func capability(udid: String, metadataSymbol: String, witnessSymbol: String) async throws -> CoreDeviceCapabilityObject {
        let key = "\(udid):\(metadataSymbol)"
        if let existing = capabilities[key] { return existing }
        let device = try await remoteDevice(udid: udid)
        guard let metadata = SSCoreDeviceSymbol(metadataSymbol),
              let witness = SSCoreDeviceSymbol(witnessSymbol)
        else { throw BridgeError.unavailable }
        let capability = CoreDeviceCapabilityObject()
        let emptyStaticMember = UnsafeMutableRawPointer.allocate(byteCount: 1, alignment: 1)
        defer { emptyStaticMember.deallocate() }
        // CapabilityStaticMember<T> is empty but resilient: its generic
        // method takes an address, actual T metadata, and its conformance.
        try await device.implementation(capability.storage, emptyStaticMember, metadata, witness)
        capability.initialized = true
        capabilities[key] = capability
        return capability
    }

    func setHingeAngle(udid: String, angle: Double) async -> Bool {
        guard angle.isFinite, (0...180).contains(angle) else { return false }
        guard let rawData = SSCoreDeviceHingeData(angle) else { return false }
        let data = Unmanaged<NSData>.fromOpaque(rawData).takeRetainedValue() as Data
        return await sendControl(udid: udid, data: data)
    }

    func setHingePose(udid: String, pose: String) async -> Bool {
        let angle: Double
        let orientation: String
        let tableMode: Bool
        // These are Device Hub's physical orientations. They must not use the
        // active panel's nativeRotation conversion used by screen rotation.
        switch pose {
        case "closed": (angle, orientation, tableMode) = (0, "portrait", false)
        case "open": (angle, orientation, tableMode) = (180, "portrait", false)
        case "laptop": (angle, orientation, tableMode) = (90, "landscape-left", false)
        case "book": (angle, orientation, tableMode) = (90, "portrait", false)
        case "tent": (angle, orientation, tableMode) = (80, "facedown", true)
        default: return false
        }
        // Release the table sensor before leaving a tabletop pose.
        if !tableMode, !(await setTableMode(udid: udid, enabled: false)) { return false }
        guard await setHingeAngle(udid: udid, angle: angle) else { return false }
        if tableMode {
            // Face down preserves the last interface orientation. Activate the
            // cover with Table Mode while holding landscape, so iOS can rotate
            // that display before the final face-down event replaces gravity.
            guard await setPhysicalOrientation(udid: udid, value: "landscape-left"),
                  await setTableMode(udid: udid, enabled: true) else { return false }
            let clock = ContinuousClock()
            let deadline = clock.now.advanced(by: .milliseconds(1500))
            while clock.now < deadline {
                if let displays = try? await CoreDeviceDisplayInfo.read(udid: udid),
                   displays.contains(where: { $0.screenID == 1 && $0.isActive && $0.orientation == "landscape_left" }) { break }
                do { try await Task.sleep(for: .milliseconds(50)) }
                catch { return false }
            }
            // Readback is best effort: apps that lock portrait must still be
            // able to enter Tent, and optional display metadata can be absent.
        }
        return await setPhysicalOrientation(udid: udid, value: orientation)
    }

    func setTableMode(udid: String, enabled: Bool) async -> Bool {
        // Older Xcodes can provide hinge/rotation controls without the table
        // sensor. Releasing an unavailable sensor is a no-op; enabling it must
        // still fail, and a real send failure must not be reported as success.
        guard SSCoreDeviceTableModeAvailable() else {
            fputs("[hid] CoreDevice Table Mode unavailable in this Xcode\n", stderr)
            return !enabled
        }
        do {
            let metadataSymbol = "$s10CoreDevice29UniversalHIDServiceCapabilityVN"
            let capability = try await capability(
                udid: udid, metadataSymbol: metadataSymbol,
                witnessSymbol: "$s10CoreDevice29UniversalHIDServiceCapabilityVAA0bE0AAWP"
            )
            let sent = SSCoreDeviceSendTableMode(capability.storage, enabled)
            if !sent { capabilities.removeValue(forKey: "\(udid):\(metadataSymbol)") }
            return sent
        } catch BridgeError.unavailable {
            fputs("[hid] CoreDevice Table Mode capability unavailable\n", stderr)
            return !enabled
        } catch {
            fputs("[hid] CoreDevice Table Mode failed: \(error)\n", stderr)
            return false
        }
    }

    private func setPhysicalOrientation(udid: String, value: String) async -> Bool {
        guard let rawData = value.withCString({ SSCoreDeviceOrientationData($0) }) else { return false }
        let data = Unmanaged<NSData>.fromOpaque(rawData).takeRetainedValue() as Data
        return await sendControl(udid: udid, data: data)
    }

    func setOrientation(udid: String, deviceOrientation: UInt32, nativeRotation: Int = 0) async -> Bool {
        guard let value = SimulatorScreenOrientation.vendorControlValue(
                  forDeviceOrientation: deviceOrientation, nativeRotation: nativeRotation
              ) else { return false }
        return await setPhysicalOrientation(udid: udid, value: value)
    }

    private func sendControl(udid: String, data: Data) async -> Bool {
        do {
            let capability = try await capability(
                udid: udid,
                metadataSymbol: "$s10CoreDevice26VendorDefinedHIDCapabilityVN",
                witnessSymbol: "$s10CoreDevice26VendorDefinedHIDCapabilityVAA0B10CapabilityAAWP"
            )
            let words = unsafeBitCast(data, to: (UInt64, UInt64).self)
            let sent = withExtendedLifetime(data) {
                SSCoreDeviceSendControl(capability.storage, words.0, words.1)
            }
            if !sent { capabilities.removeValue(forKey: "\(udid):$s10CoreDevice26VendorDefinedHIDCapabilityVN") }
            return sent
        } catch {
            fputs("[hid] CoreDevice control unavailable: \(error)\n", stderr)
            return false
        }
    }

    func supportsHingeAngle(udid: String) async -> Bool {
        guard #available(macOS 15.0, *) else { return false }
        if let supported = hingeSupport[udid] { return supported }
        guard SSCoreDeviceMotionAvailable(),
              let managerMetadata = SSCoreDeviceMotionManagerMetadata(),
              let errorMetadata = SSCoreDeviceErrorMetadata(),
              let callPointer = SSCoreDeviceMotionManagerPointer()
        else { return false }
        do {
            let capability = try await capability(
                udid: udid,
                metadataSymbol: "$s10CoreDevice23MonitorMotionCapabilityVN",
                witnessSymbol: "$s10CoreDevice23MonitorMotionCapabilityVAA0bE0AAWP"
            )
            let result = UnsafeMutableRawPointer.allocate(byteCount: Int(SSCoreDeviceValueSize(managerMetadata)), alignment: 16)
            let errorBuffer = UnsafeMutableRawPointer.allocate(byteCount: Int(SSCoreDeviceValueSize(errorMetadata)), alignment: 16)
            defer { result.deallocate(); errorBuffer.deallocate() }
            // The real resilient error is written into `error`. An empty
            // typed error preserves the async failure flag without interpreting
            // Apple's private CoreDeviceError layout in Swift.
            typealias MotionCall = @convention(thin) (UnsafeMutableRawPointer, UnsafeMutableRawPointer, UnsafeRawPointer, UnsafeRawPointer, UnsafeRawPointer) async throws(CoreDeviceCallFailed) -> Void
            let call = unsafeBitCast(callPointer, to: MotionCall.self)
            do {
                try await call(result, errorBuffer,
                               capability.storage.load(fromByteOffset: 24, as: UnsafeRawPointer.self),
                               capability.storage.load(fromByteOffset: 32, as: UnsafeRawPointer.self),
                               capability.storage)
            } catch {
                SSCoreDeviceDestroyValue(errorBuffer, errorMetadata)
                return false
            }
            defer { SSCoreDeviceDestroyValue(result, managerMetadata) }
            let supported = SSCoreDeviceMotionSupportsHinge(result)
            hingeSupport[udid] = supported
            return supported
        } catch {
            // MonitorMotion is absent on ordinary nonfoldable simulators.
            return false
        }
    }
}

private struct CoreDeviceCallFailed: Error {}

// These types supply the Swift calling convention only. Objects and protocol
// metadata always come from CoreDevice; no instance of a substitute is made.
private protocol CoreDeviceServiceConnection {}
private protocol CoreDeviceOpaqueCapability {}

@_silgen_name("SSCDShared")
private func coreDeviceSharedManager() -> CoreDeviceManagerObject
@_silgen_name("SSCDConnection")
private func coreDeviceServiceConnection() -> any CoreDeviceServiceConnection
@_silgen_name("SSCDVisibilityAllCases")
private func coreDeviceVisibilityAllCases() -> UnsafeRawPointer

private class CoreDeviceManagerObject {
    @_silgen_name("SSCDCreateManager")
    static func create(connection: __owned any CoreDeviceServiceConnection, allowed: UnsafeRawPointer) -> CoreDeviceManagerObject
    @_silgen_name("SSCDAllDevices")
    final func allDevices() -> [CoreDeviceRemoteDevice]
    @_silgen_name("SSCDInitialized")
    final func initialized() -> Bool
}

class CoreDeviceRemoteDevice {
    @_silgen_name("SSCDIdentifier")
    final func identifier() -> UUID
    @_silgen_name("SSCDImplementation")
    final func implementation(_ result: UnsafeMutableRawPointer, _ empty: UnsafeRawPointer, _ metadata: UnsafeRawPointer, _ witness: UnsafeRawPointer) async throws
    @_silgen_name("SSCDDisplayInfo")
    final func displayInfo(_ result: UnsafeMutableRawPointer) async throws
}

final class CoreDeviceCapabilityObject {
    let storage = UnsafeMutableRawPointer.allocate(byteCount: MemoryLayout<any CoreDeviceOpaqueCapability>.size, alignment: MemoryLayout<any CoreDeviceOpaqueCapability>.alignment)
    var initialized = false

    deinit {
        if initialized {
            // Swift destroys the existential using the actual implementation's
            // metadata, including boxed values if Apple changes the type.
            storage.assumingMemoryBound(to: (any CoreDeviceOpaqueCapability).self).deinitialize(count: 1)
        }
        storage.deallocate()
    }
}
