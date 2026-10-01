// SimMicInjector — replaces the iOS Simulator's microphone input for one app.
//
// Every recording API in the simulator (AVAudioEngine, AVAudioRecorder,
// AudioQueue, RemoteIO and VoiceProcessingIO audio units) ends in a HAL
// IOProc that the app process registers with AudioDeviceCreateIOProcID. This
// dylib interposes that call, wraps the IOProc, and overwrites its input
// buffers with PCM from the host helper's shared-memory ring before the
// original IOProc runs. Higher layers then convert and deliver it as usual.
//
// dyld applies __interpose tuples only to images inserted at launch, so this
// dylib must come in through DYLD_INSERT_LIBRARIES, not a later dlopen.
//
// The iOS SDK ships the HAL functions in CoreAudio.tbd without the macOS
// AudioHardware.h header, so the few declarations needed are spelled out here.

#include <CoreAudioTypes/CoreAudioTypes.h>
#include <Block.h>
#include <dispatch/dispatch.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#include "SimMicShared.h"

typedef UInt32 AudioObjectID;
typedef struct { UInt32 mSelector, mScope, mElement; } AudioObjectPropertyAddress;
typedef OSStatus (*AudioDeviceIOProc)(AudioObjectID, const AudioTimeStamp *, const AudioBufferList *,
                                      const AudioTimeStamp *, AudioBufferList *, const AudioTimeStamp *, void *);
typedef AudioDeviceIOProc AudioDeviceIOProcID;
typedef void (^AudioDeviceIOBlock)(const AudioTimeStamp *, const AudioBufferList *, const AudioTimeStamp *,
                                   AudioBufferList *, const AudioTimeStamp *);

extern OSStatus AudioDeviceCreateIOProcID(AudioObjectID, AudioDeviceIOProc, void *, AudioDeviceIOProcID *);
extern OSStatus AudioDeviceCreateIOProcIDWithBlock(AudioDeviceIOProcID *, AudioObjectID, dispatch_queue_t,
                                                   AudioDeviceIOBlock);
extern OSStatus AudioDeviceDestroyIOProcID(AudioObjectID, AudioDeviceIOProcID);
extern OSStatus AudioObjectGetPropertyData(AudioObjectID, const AudioObjectPropertyAddress *, UInt32,
                                           const void *, UInt32 *, void *);

#define FOURCC(a, b, c, d) ((UInt32)(a) << 24 | (UInt32)(b) << 16 | (UInt32)(c) << 8 | (UInt32)(d))
#define kSelNominalSampleRate FOURCC('n', 's', 'r', 't')
#define kSelStreamFormat      FOURCC('s', 'f', 'm', 't')
#define kScopeGlobal          FOURCC('g', 'l', 'o', 'b')
#define kScopeInput           FOURCC('i', 'n', 'p', 't')

#define SIMMIC_LOG(...) do { fprintf(stderr, "[SimMic] " __VA_ARGS__); fputc('\n', stderr); } while (0)

#define INTERPOSE(replacement, original)                                          \
    __attribute__((used)) static const struct { const void *r, *o; }              \
    _interpose_##original __attribute__((section("__DATA,__interpose"))) = {       \
        (const void *)(replacement), (const void *)(original)}

// ─── Shared memory ───

// The live mapping. Swapped atomically when the helper restarts; old mappings
// are never unmapped because an IOProc may still be reading one.
static _Atomic(const SimMicShmHeader *) gHeader;
static const char *gShmName;

static const SimMicShmHeader *MapRegion(void) {
    int fd = shm_open(gShmName, O_RDONLY, 0);
    if (fd < 0) return NULL;
    const SimMicShmHeader *result = NULL;
    void *head = mmap(NULL, sizeof(SimMicShmHeader), PROT_READ, MAP_SHARED, fd, 0);
    if (head != MAP_FAILED) {
        const SimMicShmHeader *h = head;
        uint32_t capacity = h->capacityFrames;
        bool valid = h->magic == SIMMIC_SHM_MAGIC && h->version == SIMMIC_VERSION &&
                     h->sampleRate == SIMMIC_SAMPLE_RATE && capacity > 0 &&
                     capacity <= SIMMIC_SAMPLE_RATE * 60u;
        munmap(head, sizeof(SimMicShmHeader));
        if (valid) {
            void *full = mmap(NULL, SimMicRegionSize(capacity), PROT_READ, MAP_SHARED, fd, 0);
            if (full != MAP_FAILED) result = full;
        }
    }
    close(fd);
    return result;
}

// Background poll: picks up the region when the helper (re)starts.
static void RefreshMapping(void) {
    const SimMicShmHeader *current = atomic_load(&gHeader);
    const SimMicShmHeader *fresh = MapRegion();
    if (!fresh) return;
    if (current && current->sessionId == fresh->sessionId) {
        munmap((void *)fresh, SimMicRegionSize(fresh->capacityFrames));
        return;
    }
    atomic_store(&gHeader, fresh);
    SIMMIC_LOG("attached to %s (session %llx)", gShmName, (unsigned long long)fresh->sessionId);
}

// ─── IOProc wrapper ───

typedef enum { kSampleFloat32, kSampleInt16, kSampleInt32, kSampleUnsupported } SampleKind;

typedef struct {
    AudioDeviceIOProc proc;   // original C IOProc, or NULL for the block form
    void *context;
    AudioDeviceIOBlock block; // original block, when created WithBlock
    double deviceRate;
    SampleKind kind;
    double readPos;           // ring position in SIMMIC_SAMPLE_RATE frames
    bool positioned;
} Wrapper;

static SampleKind KindForFormat(const AudioStreamBasicDescription *f) {
    if (f->mFormatID != kAudioFormatLinearPCM) return kSampleUnsupported;
    if ((f->mFormatFlags & kAudioFormatFlagIsFloat) && f->mBitsPerChannel == 32) return kSampleFloat32;
    if (f->mFormatFlags & kAudioFormatFlagIsSignedInteger) {
        if (f->mBitsPerChannel == 16) return kSampleInt16;
        if (f->mBitsPerChannel == 32) return kSampleInt32;
    }
    return kSampleUnsupported;
}

static Wrapper *NewWrapper(AudioObjectID device) {
    Wrapper *w = calloc(1, sizeof(Wrapper));
    if (!w) return NULL;

    Float64 rate = 0;
    UInt32 size = sizeof(rate);
    AudioObjectPropertyAddress rateAddr = {kSelNominalSampleRate, kScopeGlobal, 0};
    if (AudioObjectGetPropertyData(device, &rateAddr, 0, NULL, &size, &rate) != noErr || rate <= 0) rate = 48000;
    w->deviceRate = rate;

    // Most simulator input devices report packed Float32; the integer forms
    // cover anything else the host hands over.
    AudioStreamBasicDescription format = {0};
    size = sizeof(format);
    AudioObjectPropertyAddress formatAddr = {kSelStreamFormat, kScopeInput, 0};
    if (AudioObjectGetPropertyData(device, &formatAddr, 0, NULL, &size, &format) == noErr) {
        w->kind = KindForFormat(&format);
        if (format.mSampleRate > 0) w->deviceRate = format.mSampleRate;
    } else {
        w->kind = kSampleFloat32;
    }
    SIMMIC_LOG("wrapping IOProc on device %u (%.0f Hz, sample kind %d)", device, w->deviceRate, (int)w->kind);
    return w;
}

static inline void Store(void *data, SampleKind kind, UInt32 index, float value) {
    if (value > 1.0f) value = 1.0f;
    if (value < -1.0f) value = -1.0f;
    switch (kind) {
        case kSampleFloat32: ((float *)data)[index] = value; break;
        case kSampleInt16: ((int16_t *)data)[index] = (int16_t)lrintf(value * 32767.0f); break;
        case kSampleInt32: ((int32_t *)data)[index] = (int32_t)lrint((double)value * 2147483647.0); break;
        case kSampleUnsupported: break;
    }
}

static inline UInt32 BytesPerSample(SampleKind kind) {
    return kind == kSampleInt16 ? 2 : 4;
}

static void FillInput(Wrapper *w, const AudioBufferList *input) {
    if (!input || input->mNumberBuffers == 0 || w->kind == kSampleUnsupported) return;
    const SimMicShmHeader *h = atomic_load_explicit(&gHeader, memory_order_acquire);

    // Frames in this cycle, from the first buffer's layout.
    const AudioBuffer *first = &input->mBuffers[0];
    UInt32 firstChannels = first->mNumberChannels ? first->mNumberChannels : 1;
    UInt32 frames = first->mDataByteSize / (BytesPerSample(w->kind) * firstChannels);
    if (frames == 0) return;

    uint64_t written = 0, clipStart = 0, clipEnd = 0;
    uint32_t idle = SIMMIC_IDLE_SILENCE;
    if (h) {
        written = atomic_load_explicit(&h->writeFrames, memory_order_acquire);
        clipStart = atomic_load_explicit(&h->clipStart, memory_order_acquire);
        clipEnd = atomic_load_explicit(&h->clipEnd, memory_order_acquire);
        idle = atomic_load_explicit(&h->idleMode, memory_order_relaxed);
    }

    // Hold the read position about one lead behind the writer. Resync when
    // clock drift or a stall pushes it outside a comfortable window.
    if (h) {
        double behind = (double)written - w->readPos;
        if (!w->positioned || behind < SIMMIC_LEAD_FRAMES / 4.0 || behind > SIMMIC_LEAD_FRAMES * 3.0) {
            w->readPos = written > SIMMIC_LEAD_FRAMES ? (double)(written - SIMMIC_LEAD_FRAMES) : 0;
            w->positioned = true;
        }
    }

    const float *ring = h ? (const float *)((const uint8_t *)h + SIMMIC_SAMPLES_OFFSET) : NULL;
    uint32_t capacity = h ? h->capacityFrames : 0;
    double step = (double)SIMMIC_SAMPLE_RATE / w->deviceRate;
    bool passthrough = idle == SIMMIC_IDLE_PASSTHROUGH;

    for (UInt32 f = 0; f < frames; f++) {
        double pos = w->readPos + f * step;
        uint64_t i0 = (uint64_t)pos;
        bool inject = ring && i0 + 1 < written && i0 >= clipStart && i0 < clipEnd;
        if (!inject && passthrough) continue;

        float value = 0;
        if (inject) {
            float frac = (float)(pos - (double)i0);
            float a = ring[i0 % capacity];
            float b = ring[(i0 + 1) % capacity];
            value = a + (b - a) * frac;
        }
        for (UInt32 b = 0; b < input->mNumberBuffers; b++) {
            const AudioBuffer *buf = &input->mBuffers[b];
            UInt32 channels = buf->mNumberChannels ? buf->mNumberChannels : 1;
            if (f >= buf->mDataByteSize / (BytesPerSample(w->kind) * channels)) continue;
            for (UInt32 c = 0; c < channels; c++) Store(buf->mData, w->kind, f * channels + c, value);
        }
    }
    if (h) w->readPos += frames * step;
}

static OSStatus WrappedIOProc(AudioObjectID device, const AudioTimeStamp *now, const AudioBufferList *input,
                              const AudioTimeStamp *inputTime, AudioBufferList *output,
                              const AudioTimeStamp *outputTime, void *context) {
    Wrapper *w = context;
    FillInput(w, input);
    return w->proc(device, now, input, inputTime, output, outputTime, w->context);
}

// IOProc IDs map back to wrappers so DestroyIOProcID can free them.
#define MAX_WRAPPERS 64
static struct { AudioDeviceIOProcID id; Wrapper *wrapper; } gWrappers[MAX_WRAPPERS];
static pthread_mutex_t gWrappersLock = PTHREAD_MUTEX_INITIALIZER;

static void Remember(AudioDeviceIOProcID id, Wrapper *w) {
    pthread_mutex_lock(&gWrappersLock);
    for (int i = 0; i < MAX_WRAPPERS; i++) {
        if (!gWrappers[i].id) { gWrappers[i].id = id; gWrappers[i].wrapper = w; break; }
    }
    pthread_mutex_unlock(&gWrappersLock);
}

static Wrapper *Forget(AudioDeviceIOProcID id) {
    Wrapper *w = NULL;
    pthread_mutex_lock(&gWrappersLock);
    for (int i = 0; i < MAX_WRAPPERS; i++) {
        if (gWrappers[i].id == id) { w = gWrappers[i].wrapper; gWrappers[i].id = NULL; gWrappers[i].wrapper = NULL; break; }
    }
    pthread_mutex_unlock(&gWrappersLock);
    return w;
}

// ─── Interposed HAL calls ───

static OSStatus SimMic_CreateIOProcID(AudioObjectID device, AudioDeviceIOProc proc, void *context,
                                      AudioDeviceIOProcID *outID) {
    Wrapper *w = proc ? NewWrapper(device) : NULL;
    if (!w) return AudioDeviceCreateIOProcID(device, proc, context, outID);
    w->proc = proc;
    w->context = context;
    OSStatus status = AudioDeviceCreateIOProcID(device, WrappedIOProc, w, outID);
    if (status == noErr && outID) Remember(*outID, w);
    else free(w);
    return status;
}
INTERPOSE(SimMic_CreateIOProcID, AudioDeviceCreateIOProcID);

static OSStatus SimMic_CreateIOProcIDWithBlock(AudioDeviceIOProcID *outID, AudioObjectID device,
                                               dispatch_queue_t queue, AudioDeviceIOBlock block) {
    Wrapper *w = block ? NewWrapper(device) : NULL;
    if (!w) return AudioDeviceCreateIOProcIDWithBlock(outID, device, queue, block);
    w->block = Block_copy(block);
    AudioDeviceIOBlock wrapped = ^(const AudioTimeStamp *now, const AudioBufferList *input,
                                   const AudioTimeStamp *inputTime, AudioBufferList *output,
                                   const AudioTimeStamp *outputTime) {
        FillInput(w, input);
        w->block(now, input, inputTime, output, outputTime);
    };
    OSStatus status = AudioDeviceCreateIOProcIDWithBlock(outID, device, queue, wrapped);
    if (status == noErr && outID) Remember(*outID, w);
    else { Block_release(w->block); free(w); }
    return status;
}
INTERPOSE(SimMic_CreateIOProcIDWithBlock, AudioDeviceCreateIOProcIDWithBlock);

static OSStatus SimMic_DestroyIOProcID(AudioObjectID device, AudioDeviceIOProcID id) {
    OSStatus status = AudioDeviceDestroyIOProcID(device, id);
    if (status == noErr) {
        // The HAL guarantees the IOProc is no longer running once this returns.
        Wrapper *w = Forget(id);
        if (w) {
            if (w->block) Block_release(w->block);
            free(w);
        }
    }
    return status;
}
INTERPOSE(SimMic_DestroyIOProcID, AudioDeviceDestroyIOProcID);

// ─── Setup ───

__attribute__((constructor)) static void SimMicInit(void) {
    const char *name = getenv("SIMMIC_SHM_NAME");
    if (!name || !*name) {
        SIMMIC_LOG("SIMMIC_SHM_NAME not set; microphone input is silent");
        return;
    }
    gShmName = strdup(name);
    RefreshMapping();
    if (!atomic_load(&gHeader)) SIMMIC_LOG("shm %s not ready yet; will retry", gShmName);

    // libdispatch is part of libSystem, so this is safe from a constructor.
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
                                                     dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), NSEC_PER_SEC,
                              NSEC_PER_SEC / 4);
    dispatch_source_set_event_handler(timer, ^{ RefreshMapping(); });
    dispatch_resume(timer);
}
