import CoreVideo
import VideoToolbox

struct Dimensions: Hashable, Sendable {
    var width: Int
    var height: Int
}

extension CVPixelBuffer {
    var dimensions: Dimensions {
        Dimensions(width: CVPixelBufferGetWidth(self), height: CVPixelBufferGetHeight(self))
    }
}

struct Photocopier {
    var pixelFormat: OSType = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    private var _pool: CVPixelBufferPool?
    private var dimensions: Dimensions?
    private var poolFormat: OSType = 0
    private var _plainPool: CVPixelBufferPool?
    private var plainDimensions: Dimensions?
    private var transfer: VTPixelTransferSession?
    private(set) var cpuFallbacks: UInt64 = 0

    init() {}

    /// Even dimensions only: odd sizes cost the encoder an extra conversion.
    static func target(for source: CVPixelBuffer, maxDimension: Int) -> Dimensions {
        let size = source.dimensions
        let longest = max(size.width, size.height)
        guard maxDimension > 0, longest > maxDimension else { return size }
        let scale = Double(maxDimension) / Double(longest)
        return Dimensions(
            width: max(2, Int((Double(size.width) * scale).rounded()) & ~1),
            height: max(2, Int((Double(size.height) * scale).rounded()) & ~1)
        )
    }

    private mutating func plainPool(dimensions: Dimensions) -> CVPixelBufferPool? {
        if let _plainPool, plainDimensions == dimensions { return _plainPool }
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: dimensions.width,
            kCVPixelBufferHeightKey as String: dimensions.height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var newPool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &newPool)
        _plainPool = newPool
        plainDimensions = dimensions
        return newPool
    }

    private mutating func pool(dimensions: Dimensions) -> CVPixelBufferPool? {
        if let _pool, self.dimensions == dimensions, self.poolFormat == pixelFormat {
            return _pool
        }
        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
            kCVPixelBufferWidthKey as String: Int(dimensions.width),
            kCVPixelBufferHeightKey as String: Int(dimensions.height),
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ]
        var newPool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attrs as CFDictionary, &newPool)
        self._pool = newPool
        self.dimensions = dimensions
        self.poolFormat = pixelFormat
        return newPool
    }

    private mutating func transferSession() -> VTPixelTransferSession? {
        if let transfer { return transfer }
        var session: VTPixelTransferSession?
        guard VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault,
                                           pixelTransferSessionOut: &session) == noErr,
              let session else { return nil }
        VTSessionSetProperty(session,
                             key: kVTPixelTransferPropertyKey_ScalingMode,
                             value: kVTScalingMode_Normal)
        transfer = session
        return session
    }

    /// Snapshot `source` (which wraps the recycled framebuffer IOSurface) into a private
    /// pooled buffer that sinks can retain.
    ///
    /// The transfer runs on the GPU. Locking the framebuffer for a CPU copy instead means
    /// waiting for the compositor's writes to be made visible to the CPU, which is where
    /// this stalled for hundreds of milliseconds during full-screen transitions.
    mutating func copy(_ source: CVPixelBuffer, maxDimension: Int = 0) -> CVPixelBuffer? {
        guard let pool = self.pool(dimensions: Self.target(for: source, maxDimension: maxDimension))
        else { return nil }
        guard let dst = Self.buffer(from: pool) else { return nil }

        if let session = transferSession(),
           VTPixelTransferSessionTransferImage(session, from: source, to: dst) == noErr {
            return dst
        }
        // Without the transfer there is no GPU convert or resize, so degrade to what the
        // pipeline did before: a same-size copy in the framebuffer's own format, which the
        // consumers already know how to scale.
        cpuFallbacks += 1
        guard let plain = plainPool(dimensions: source.dimensions),
              let out = Self.buffer(from: plain),
              Self.copyOnCPU(source, into: out) else { return nil }
        return out
    }

    private static func buffer(from pool: CVPixelBufferPool) -> CVPixelBuffer? {
        var out: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out) == kCVReturnSuccess
        else { return nil }
        return out
    }

    /// Only reached if the GPU transfer fails. Handles planar buffers, whose base address is
    /// NULL: reading it as packed would drop every frame.
    private static func copyOnCPU(_ source: CVPixelBuffer, into dst: CVPixelBuffer) -> Bool {
        guard source.dimensions == dst.dimensions,
              CVPixelBufferGetPixelFormatType(source) == CVPixelBufferGetPixelFormatType(dst)
        else { return false }
        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        let planes = max(1, CVPixelBufferGetPlaneCount(source))
        let planar = CVPixelBufferIsPlanar(source)
        for plane in 0..<planes {
            let srcAddr = planar
                ? CVPixelBufferGetBaseAddressOfPlane(source, plane)
                : CVPixelBufferGetBaseAddress(source)
            let dstAddr = planar
                ? CVPixelBufferGetBaseAddressOfPlane(dst, plane)
                : CVPixelBufferGetBaseAddress(dst)
            guard let srcAddr, let dstAddr else { return false }
            let srcStride = planar
                ? CVPixelBufferGetBytesPerRowOfPlane(source, plane)
                : CVPixelBufferGetBytesPerRow(source)
            let dstStride = planar
                ? CVPixelBufferGetBytesPerRowOfPlane(dst, plane)
                : CVPixelBufferGetBytesPerRow(dst)
            let rows = planar
                ? CVPixelBufferGetHeightOfPlane(source, plane)
                : CVPixelBufferGetHeight(source)
            let bytes = min(srcStride, dstStride)
            for row in 0..<rows {
                memcpy(dstAddr + row * dstStride, srcAddr + row * srcStride, bytes)
            }
        }
        return true
    }
}
