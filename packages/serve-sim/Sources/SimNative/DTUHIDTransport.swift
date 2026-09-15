import Foundation
import ObjectiveC
import Darwin
import XPC

/// CoreSimulator 1155.4+ hands input delivery to `dtuhidd`. The legacy Indigo
/// client still accepts messages in that configuration, but the guest drops
/// keyboard events and may drop digitizer events. This transport talks to the
/// CoreDevice HID service used by current idb and Device Hub.
///
/// Construction is capability based: older CoreSimulator versions have no
/// service, so callers retain the legacy path without checking an Xcode number.
final class DTUHIDTransport: @unchecked Sendable {
    private enum DigitizerEventType: UInt64 {
        case start = 0
        case position = 1
        case end = 2
    }

    private enum ButtonState: UInt64 {
        case down = 1
        case up = 2
    }

    private struct ContactTracker {
        private var active = false

        mutating func eventType(for type: String) -> DigitizerEventType? {
            switch type {
            case "begin", "move":
                defer { active = true }
                return active ? .position : .start
            case "end":
                active = false
                return .end
            default:
                return nil
            }
        }
    }

    private static let serviceName = "com.apple.coredevice.feature.remote.hid.digitizer"

    private typealias EndpointFromMachPort = @convention(c) (
        mach_port_t, UInt64, UInt64
    ) -> xpc_object_t?
    private typealias EnableSimToHost = @convention(c) (xpc_connection_t) -> Void
    private typealias LookupService = @convention(c) (
        AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> mach_port_t

    private let connection: xpc_connection_t
    private var contact = ContactTracker()
    private var multiTouchContact = ContactTracker()
    private var needsActivationDrain = true

    static func connect(device: NSObject) -> DTUHIDTransport? {
        guard
            let endpointSymbol = dlsym(
                UnsafeMutableRawPointer(bitPattern: -2),
                "xpc_endpoint_create_mach_port_4sim"
            ),
            let enableSymbol = dlsym(
                UnsafeMutableRawPointer(bitPattern: -2),
                "xpc_connection_enable_sim2host_4sim"
            )
        else { return nil }

        let lookupSelector = NSSelectorFromString("lookup:error:")
        guard device.responds(to: lookupSelector) else { return nil }
        let lookup = unsafeBitCast(
            class_getMethodImplementation(object_getClass(device)!, lookupSelector),
            to: LookupService.self
        )
        var error: NSError?
        let port = lookup(device, lookupSelector, serviceName as NSString, &error)
        guard port != 0 else {
            hidTransportLog("[hid] DTUHID service unavailable; using legacy Indigo")
            return nil
        }

        let endpointFromMachPort = unsafeBitCast(endpointSymbol, to: EndpointFromMachPort.self)
        let enableSimToHost = unsafeBitCast(enableSymbol, to: EnableSimToHost.self)
        guard let endpoint = endpointFromMachPort(port, 0, 0) else { return nil }
        let connection = xpc_connection_create_from_endpoint(endpoint)

        // Required for the simulator service to receive payloads. Without it,
        // the peer connects successfully but silently ignores every event.
        enableSimToHost(connection)
        xpc_connection_set_event_handler(connection) { _ in }
        xpc_connection_resume(connection)
        hidTransportLog("[hid] DTUHID transport connected")
        return DTUHIDTransport(connection: connection)
    }

    private init(connection: xpc_connection_t) {
        self.connection = connection
    }

    deinit {
        xpc_connection_cancel(connection)
    }

    func sendKeyboard(type: String, usage: UInt32) {
        guard let state = buttonState(type) else { return }
        let payload = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_uint64(payload, "usageCode", UInt64(usage))
        xpc_dictionary_set_uint64(payload, "state", state.rawValue)
        send(messageType: "IndigoKeyboardButtonEvent", payload: payload)
        if type == "up" { activateConnectionIfNeeded() }
    }

    func sendButton(page: UInt32, usage: UInt32, phase: String) {
        func emit(_ state: ButtonState) {
            let payload = xpc_dictionary_create(nil, nil, 0)
            xpc_dictionary_set_uint64(payload, "usagePage", UInt64(page))
            xpc_dictionary_set_uint64(payload, "usageCode", UInt64(usage))
            xpc_dictionary_set_uint64(payload, "state", state.rawValue)
            send(messageType: "IndigoButtonEvent", payload: payload)
        }
        switch phase {
        case "down": emit(.down)
        case "up": emit(.up); activateConnectionIfNeeded()
        default: emit(.down); emit(.up); activateConnectionIfNeeded()
        }
    }

    func sendTouch(type: String, x: Double, y: Double, edge: UInt32) {
        guard let eventType = contact.eventType(for: type) else { return }
        sendDigitizer(eventType: eventType, x1: x, y1: y, x2: nil, y2: nil, edge: edge)
        if type == "end" { activateConnectionIfNeeded() }
    }

    func sendMultiTouch(type: String, x1: Double, y1: Double, x2: Double, y2: Double) {
        guard let eventType = multiTouchContact.eventType(for: type) else { return }
        sendDigitizer(eventType: eventType, x1: x1, y1: y1, x2: x2, y2: y2, edge: 0)
        if type == "end" { activateConnectionIfNeeded() }
    }

    private func sendDigitizer(
        eventType: DigitizerEventType,
        x1: Double,
        y1: Double,
        x2: Double?,
        y2: Double?,
        edge: UInt32
    ) {
        let payload = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_value(payload, "pointOne", point(x: x1, y: y1))
        if let x2, let y2 {
            xpc_dictionary_set_value(payload, "pointTwo", point(x: x2, y: y2))
        }
        xpc_dictionary_set_uint64(payload, "eventType", eventType.rawValue)
        xpc_dictionary_set_uint64(payload, "edge", UInt64(edge))
        xpc_dictionary_set_uint64(payload, "target", 0)
        send(messageType: "IndigoDigitizerEvent", payload: payload)
    }

    private func point(x: Double, y: Double) -> xpc_object_t {
        let value = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_double(value, "x", x)
        xpc_dictionary_set_double(value, "y", y)
        return value
    }

    private func buttonState(_ type: String) -> ButtonState? {
        switch type {
        case "down": return .down
        case "up": return .up
        default: return nil
        }
    }

    private func envelope(
        messageType: String,
        payload: xpc_object_t,
        barrier: Bool = false
    ) -> xpc_object_t {
        let message = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_string(message, "messageType", messageType)
        xpc_dictionary_set_string(message, "featureIdentifier", Self.serviceName)
        xpc_dictionary_set_bool(message, "isBarrier", barrier)
        xpc_dictionary_set_value(message, "payload", payload)
        return message
    }

    private func send(messageType: String, payload: xpc_object_t) {
        xpc_connection_send_message(
            connection,
            envelope(messageType: messageType, payload: payload)
        )
    }

    /// The first completed input sequence waits for dtuhidd to acknowledge its
    /// barrier and open the device. The helper retains the connection afterward,
    /// so later sequences can be sent without a per-event delay.
    private func activateConnectionIfNeeded() {
        guard needsActivationDrain else { return }
        let payload = xpc_dictionary_create(nil, nil, 0)
        xpc_dictionary_set_uint64(payload, "usageCode", 0)
        xpc_dictionary_set_uint64(payload, "state", ButtonState.up.rawValue)
        let barrier = envelope(
            messageType: "IndigoKeyboardButtonEvent",
            payload: payload,
            barrier: true
        )
        let done = DispatchSemaphore(value: 0)
        xpc_connection_send_message_with_reply(
            connection, barrier, DispatchQueue.global(qos: .userInitiated)
        ) { _ in done.signal() }
        if done.wait(timeout: .now() + 2) == .success { usleep(200_000) }
        else { usleep(1_000_000) }
        needsActivationDrain = false
    }
}

@inline(__always)
private func hidTransportLog(_ message: @autoclosure () -> String) {
    if ProcessInfo.processInfo.environment["SERVE_SIM_DEBUG_HID"] != nil {
        print(message())
    }
}
