// Wire format for serve-sim's simulator microphone feed.
//
// The host helper streams mono Float32 PCM at SIMMIC_SAMPLE_RATE into a ring
// buffer in POSIX shared memory. The injected dylib inside the simulator app
// reads it from the HAL IOProc and writes it over the app's input buffers.
//
// The stream never stops while the helper runs: it writes silence when no
// clip is playing, so `writeFrames` always tracks host time, a fixed lead
// ahead of real time. Readers sit about that lead behind `writeFrames`, which
// absorbs jitter between the helper's timer and the device's IO cycle.
//
// A clip occupies the frame range [clipStart, clipEnd). Readers inject only
// samples inside that range. Outside it they apply the idle mode: silence, or
// leave the real host microphone audio untouched (passthrough). Stopping a
// clip empties the range, so it cuts out at once even though the lead region
// already holds clip samples.
//
// Synchronization is lock-free. The writer fills samples, then release-stores
// `writeFrames`. A new clip clears `clipEnd` first, then sets `clipStart`,
// then `clipEnd`, so a torn read yields an empty range, never a wrong one.
//
// `sessionId` is random per helper start. Readers poll it on a background
// queue and remap when it changes, so a restarted helper reaches apps that
// are already running.

#ifndef SIM_MIC_SHARED_H
#define SIM_MIC_SHARED_H

#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>

#define SIMMIC_SHM_MAGIC        0x534D4931u  // 'SMI1'
#define SIMMIC_VERSION          1u
#define SIMMIC_SAMPLE_RATE      48000u
#define SIMMIC_CAPACITY_FRAMES  (SIMMIC_SAMPLE_RATE * 4u)
#define SIMMIC_LEAD_FRAMES      (SIMMIC_SAMPLE_RATE / 10u)  // 100 ms

#define SIMMIC_IDLE_SILENCE     0u
#define SIMMIC_IDLE_PASSTHROUGH 1u

// Header is 64 bytes. Float32 samples follow at SIMMIC_SAMPLES_OFFSET.
typedef struct {
    uint32_t magic;                  // SIMMIC_SHM_MAGIC
    uint32_t version;                // SIMMIC_VERSION
    uint32_t sampleRate;             // SIMMIC_SAMPLE_RATE
    uint32_t capacityFrames;         // ring length in frames (mono)
    uint64_t sessionId;              // random per helper start
    _Atomic uint64_t writeFrames;    // total frames written; release-stored last
    _Atomic uint64_t clipStart;      // first frame of the current clip
    _Atomic uint64_t clipEnd;        // one past the last frame; 0 = no clip
    _Atomic uint32_t idleMode;       // SIMMIC_IDLE_*
    uint8_t  reserved[12];
} SimMicShmHeader;

_Static_assert(sizeof(SimMicShmHeader) == 64, "SimMicShmHeader must be 64 bytes");
_Static_assert(offsetof(SimMicShmHeader, writeFrames) == 24, "writeFrames offset must stay stable");
_Static_assert(offsetof(SimMicShmHeader, idleMode) == 48, "idleMode offset must stay stable");

#define SIMMIC_SAMPLES_OFFSET   ((uint64_t)sizeof(SimMicShmHeader))

static inline uint64_t SimMicRegionSize(uint32_t capacityFrames) {
    return SIMMIC_SAMPLES_OFFSET + (uint64_t)capacityFrames * sizeof(float);
}

#endif
