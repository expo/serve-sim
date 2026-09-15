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
    private static let serviceName = "com.apple.coredevice.feature.remote.hid.digitizer"

    private typealias EndpointFromMachPort = @convention(c) (
        mach_port_t, UInt64, UInt64
    ) -> xpc_object_t?
    private typealias EnableSimToHost = @convention(c) (xpc_connection_t) -> Void
    private typealias LookupService = @convention(c) (
        AnyObject, Selector, NSString, AutoreleasingUnsafeMutablePointer<NSError?>
    ) -> mach_port_t

    private let connection: xpc_connection_t
    private var contactActive = false
    private var secondContactActive = false
    private var cold = true

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
        xpc_dictionary_set_uint64(payload, "state", state)
        send(messageType: "IndigoKeyboardButtonEvent", payload: payload)
        if type == "up" { drain() }
    }

    func sendButton(page: UInt32, usage: UInt32, phase: String) {
        func emit(_ state: UInt64) {
            let payload = xpc_dictionary_create(nil, nil, 0)
            xpc_dictionary_set_uint64(payload, "usagePage", UInt64(page))
            xpc_dictionary_set_uint64(payload, "usageCode", UInt64(usage))
            xpc_dictionary_set_uint64(payload, "state", state)
            send(messageType: "IndigoButtonEvent", payload: payload)
        }
        switch phase {
        case "down": emit(1)
        case "up": emit(2); drain()
        default: emit(1); emit(2); drain()
        }
    }

    func sendTouch(type: String, x: Double, y: Double, edge: UInt32) {
        guard let eventType = contactEventType(type: type, second: false) else { return }
        sendDigitizer(eventType: eventType, x1: x, y1: y, x2: nil, y2: nil, edge: edge)
        if type == "end" { drain() }
    }

    func sendMultiTouch(type: String, x1: Double, y1: Double, x2: Double, y2: Double) {
        guard let eventType = contactEventType(type: type, second: true) else { return }
        sendDigitizer(eventType: eventType, x1: x1, y1: y1, x2: x2, y2: y2, edge: 0)
        if type == "end" { drain() }
    }

    private func contactEventType(type: String, second: Bool) -> UInt64? {
        let active = second ? secondContactActive : contactActive
        let eventType: UInt64
        switch type {
        case "begin": eventType = active ? 1 : 0
        case "move": eventType = active ? 1 : 0
        case "end": eventType = 2
        default: return nil
        }
        if second { secondContactActive = type != "end" }
        else { contactActive = type != "end" }
        return eventType
    }

    private func sendDigitizer(
        eventType: UInt64,
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
        xpc_dictionary_set_uint64(payload, "eventType", eventType)
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

    private func buttonState(_ type: String) -> UInt64? {
        switch type {
        case "down": return 1
        case "up": return 2
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

    /// Keep short-lived commands alive until the guest has consumed the final
    /// phase. The first drain waits for dtuhidd's barrier reply; warm drains only
    /// need the measured transport tail.
    private func drain() {
        if cold {
            let payload = xpc_dictionary_create(nil, nil, 0)
            xpc_dictionary_set_uint64(payload, "usageCode", 0)
            xpc_dictionary_set_uint64(payload, "state", 2)
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
            cold = false
        } else {
            usleep(80_000)
        }
    }
}

@inline(__always)
private func hidTransportLog(_ message: @autoclosure () -> String) {
    if ProcessInfo.processInfo.environment["SERVE_SIM_DEBUG_HID"] != nil {
        print(message())
    }
}
