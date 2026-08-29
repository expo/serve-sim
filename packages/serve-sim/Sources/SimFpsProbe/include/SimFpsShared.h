#ifndef SIM_FPS_SHARED_H
#define SIM_FPS_SHARED_H

#include <stddef.h>
#include <stdint.h>

#define SIMFPS_SHM_MAGIC       0x53465031u  // 'SFP1'
#define SIMFPS_SHM_VERSION     1u
#define SIMFPS_SHM_SIZE        128u
#define SIMFPS_BUNDLE_ID_MAX   64u

typedef struct {
    uint32_t magic;           // 0  SIMFPS_SHM_MAGIC
    uint32_t version;         // 4  SIMFPS_SHM_VERSION
    uint32_t seq;             // 8  seqlock; even = stable
    float    fps;             // 12 rendered (Core Animation)
    float    mainThreadFps;   // 16 refresh (CADisplayLink)
    uint32_t nominalMax;      // 20 UIScreen maximumFramesPerSecond
    uint64_t timestampMs;     // 24 wall clock, writer
    char     bundleId[SIMFPS_BUNDLE_ID_MAX]; // 32
    uint32_t seqCopy;         // 96 copy of seq after payload
    uint8_t  reserved[28];    // 100
} SimFpsShmHeader;

_Static_assert(sizeof(SimFpsShmHeader) == SIMFPS_SHM_SIZE, "SimFpsShmHeader must be 128 bytes");
_Static_assert(offsetof(SimFpsShmHeader, timestampMs) == 24, "timestampMs offset must stay stable");
_Static_assert(offsetof(SimFpsShmHeader, bundleId) == 32, "bundleId offset must stay stable");
_Static_assert(offsetof(SimFpsShmHeader, seqCopy) == 96, "seqCopy offset must stay stable");

#endif
