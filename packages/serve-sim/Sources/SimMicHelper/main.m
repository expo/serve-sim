// serve-sim-mic-helper — host side of serve-sim's simulator microphone.
//
// Streams mono Float32 PCM at 48 kHz into a POSIX shared-memory ring that
// SimMicInjector reads inside the simulator app. The stream runs in real
// time, a fixed lead ahead, and carries silence between clips. See
// Sources/SimMicInjector/include/SimMicShared.h for the wire format.
//
// Control is newline-delimited JSON over a Unix socket:
//   {"action":"play","path":"/abs/file.mp3","preRollMs":250}
//   {"action":"stop"}
//   {"action":"status"}
//   {"action":"setIdle","mode":"silence"|"passthrough"}
//   {"action":"shutdown"}
// Each request gets one JSON line back with at least {"ok":bool}.

#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>
#include <fcntl.h>
#include <mach/mach_time.h>
#include <signal.h>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

#include "../SimMicInjector/include/SimMicShared.h"

#define LOG(...) do { fprintf(stderr, "[serve-sim-mic] " __VA_ARGS__); fputc('\n', stderr); } while (0)

// Ten minutes of 48 kHz mono Float32 is about 115 MB; longer files are refused.
static const uint64_t kMaxClipFrames = (uint64_t)SIMMIC_SAMPLE_RATE * 600;

static const char *gShmName;
static SimMicShmHeader *gHeader;
static float *gRing;
static volatile sig_atomic_t gShouldExit;
static int gListenFd = -1;
static dispatch_source_t gAcceptSource;

// Writer state. Touched only on gWriterQueue.
static dispatch_queue_t gWriterQueue;
static dispatch_source_t gWriterTimer;
static uint64_t gStartTicks;
static mach_timebase_info_data_t gTimebase;
static float *gClip;
static uint64_t gClipFrames;
static uint64_t gClipStart;
static NSString *gClipPath;

#pragma mark - Streaming

static uint64_t RealtimeFrames(void) {
    uint64_t elapsed = mach_absolute_time() - gStartTicks;
    double seconds = (double)elapsed * gTimebase.numer / gTimebase.denom / 1e9;
    return (uint64_t)(seconds * SIMMIC_SAMPLE_RATE);
}

// Writes from writeFrames up to real time plus the lead.
static void WriterTick(void) {
    uint64_t written = atomic_load_explicit(&gHeader->writeFrames, memory_order_relaxed);
    uint64_t target = RealtimeFrames() + SIMMIC_LEAD_FRAMES;
    if (target <= written) return;
    // After a long stall (host sleep), skip ahead instead of writing more
    // than the ring holds. Readers resync on the jump.
    uint64_t maxBurst = SIMMIC_CAPACITY_FRAMES / 2;
    if (target - written > maxBurst) written = target - maxBurst;

    uint64_t clipEnd = gClip ? gClipStart + gClipFrames : 0;
    for (uint64_t i = written; i < target; i++) {
        float value = 0;
        if (gClip && i >= gClipStart && i < clipEnd) value = gClip[i - gClipStart];
        gRing[i % SIMMIC_CAPACITY_FRAMES] = value;
    }
    atomic_store_explicit(&gHeader->writeFrames, target, memory_order_release);
}

static void StartWriter(void) {
    mach_timebase_info(&gTimebase);
    gStartTicks = mach_absolute_time();
    gWriterQueue = dispatch_queue_create("serve-sim.mic.writer",
        dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0));
    gWriterTimer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, DISPATCH_TIMER_STRICT, gWriterQueue);
    dispatch_source_set_timer(gWriterTimer, DISPATCH_TIME_NOW, 5 * NSEC_PER_MSEC, NSEC_PER_MSEC);
    dispatch_source_set_event_handler(gWriterTimer, ^{ WriterTick(); });
    dispatch_resume(gWriterTimer);
}

#pragma mark - Decoding

static float *DecodeFile(NSString *path, uint64_t *outFrames, NSString **error) {
    NSError *e = nil;
    AVAudioFile *file = [[AVAudioFile alloc] initForReading:[NSURL fileURLWithPath:path] error:&e];
    if (!file) {
        *error = [NSString stringWithFormat:@"cannot open audio file: %@", e.localizedDescription ?: path];
        return NULL;
    }
    AVAudioFormat *inFormat = file.processingFormat;
    if (file.length <= 0) { *error = @"audio file is empty"; return NULL; }
    if ((double)file.length * SIMMIC_SAMPLE_RATE / inFormat.sampleRate > (double)kMaxClipFrames) {
        *error = @"audio file is longer than 10 minutes";
        return NULL;
    }
    AVAudioFrameCount inFrames = (AVAudioFrameCount)file.length;
    AVAudioPCMBuffer *input = [[AVAudioPCMBuffer alloc] initWithPCMFormat:inFormat frameCapacity:inFrames];
    if (![file readIntoBuffer:input error:&e]) {
        *error = [NSString stringWithFormat:@"cannot read audio file: %@", e.localizedDescription];
        return NULL;
    }

    AVAudioFormat *outFormat = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32
                                                                 sampleRate:SIMMIC_SAMPLE_RATE
                                                                   channels:1
                                                                interleaved:NO];
    AVAudioConverter *converter = [[AVAudioConverter alloc] initFromFormat:inFormat toFormat:outFormat];
    if (!converter) { *error = @"unsupported audio format"; return NULL; }
    converter.downmix = YES;
    AVAudioFrameCount capacity =
        (AVAudioFrameCount)ceil((double)inFrames * SIMMIC_SAMPLE_RATE / inFormat.sampleRate) + 4096;
    AVAudioPCMBuffer *output = [[AVAudioPCMBuffer alloc] initWithPCMFormat:outFormat frameCapacity:capacity];
    __block BOOL supplied = NO;
    AVAudioConverterOutputStatus status = [converter convertToBuffer:output error:&e
        withInputFromBlock:^AVAudioBuffer *(AVAudioPacketCount count, AVAudioConverterInputStatus *inputStatus) {
            (void)count;
            if (supplied) { *inputStatus = AVAudioConverterInputStatus_EndOfStream; return nil; }
            supplied = YES;
            *inputStatus = AVAudioConverterInputStatus_HaveData;
            return input;
        }];
    if (status == AVAudioConverterOutputStatus_Error || output.frameLength == 0) {
        *error = [NSString stringWithFormat:@"cannot convert audio: %@", e.localizedDescription ?: @"no frames"];
        return NULL;
    }
    float *samples = malloc(output.frameLength * sizeof(float));
    if (!samples) { *error = @"out of memory"; return NULL; }
    memcpy(samples, output.floatChannelData[0], output.frameLength * sizeof(float));
    *outFrames = output.frameLength;
    return samples;
}

#pragma mark - Commands

static NSString *IdleName(uint32_t mode) {
    return mode == SIMMIC_IDLE_PASSTHROUGH ? @"passthrough" : @"silence";
}

// Called on gWriterQueue.
static void ClearClip(void) {
    atomic_store_explicit(&gHeader->clipEnd, 0, memory_order_release);
    atomic_store_explicit(&gHeader->clipStart, 0, memory_order_release);
    free(gClip);
    gClip = NULL;
    gClipFrames = 0;
    gClipStart = 0;
    gClipPath = nil;
}

static NSDictionary *StatusReply(void) {
    __block NSDictionary *reply;
    dispatch_sync(gWriterQueue, ^{
        uint64_t written = atomic_load(&gHeader->writeFrames);
        uint64_t now = written > SIMMIC_LEAD_FRAMES ? written - SIMMIC_LEAD_FRAMES : 0;
        uint64_t end = gClip ? gClipStart + gClipFrames : 0;
        BOOL playing = gClip && now < end;
        double position = gClip && now > gClipStart ? (double)MIN(now, end) - (double)gClipStart : 0;
        reply = @{
            @"ok": @YES,
            @"playing": @(playing),
            @"path": gClipPath ?: [NSNull null],
            @"durationMs": @(gClip ? round(gClipFrames * 1000.0 / SIMMIC_SAMPLE_RATE) : 0),
            @"positionMs": @(round(position * 1000.0 / SIMMIC_SAMPLE_RATE)),
            @"idle": IdleName(atomic_load(&gHeader->idleMode)),
            @"sampleRate": @(SIMMIC_SAMPLE_RATE),
        };
    });
    return reply;
}

static NSDictionary *HandleCommand(NSDictionary *cmd) {
    NSString *action = [cmd[@"action"] isKindOfClass:NSString.class] ? cmd[@"action"] : @"";

    if ([action isEqualToString:@"status"]) return StatusReply();

    if ([action isEqualToString:@"play"]) {
        NSString *path = [cmd[@"path"] isKindOfClass:NSString.class] ? cmd[@"path"] : nil;
        if (!path.length) return @{@"ok": @NO, @"error": @"play needs a path"};
        double preRollMs = [cmd[@"preRollMs"] isKindOfClass:NSNumber.class] ? [cmd[@"preRollMs"] doubleValue] : 0;
        if (preRollMs < 0 || preRollMs > 60000) return @{@"ok": @NO, @"error": @"preRollMs must be 0-60000"};
        NSString *error = nil;
        uint64_t frames = 0;
        float *samples = DecodeFile(path, &frames, &error);
        if (!samples) return @{@"ok": @NO, @"error": error};
        uint64_t preRoll = (uint64_t)(preRollMs * SIMMIC_SAMPLE_RATE / 1000.0);
        dispatch_sync(gWriterQueue, ^{
            ClearClip();
            uint64_t start = atomic_load(&gHeader->writeFrames) + preRoll;
            gClip = samples;
            gClipFrames = frames;
            gClipStart = start;
            gClipPath = path;
            // clipEnd was cleared first, so readers never see a stale range.
            atomic_store_explicit(&gHeader->clipStart, start, memory_order_release);
            atomic_store_explicit(&gHeader->clipEnd, start + frames, memory_order_release);
        });
        LOG("playing %s (%.0f ms)", path.UTF8String, frames * 1000.0 / SIMMIC_SAMPLE_RATE);
        NSMutableDictionary *reply = [StatusReply() mutableCopy];
        reply[@"playing"] = @YES;
        return reply;
    }

    if ([action isEqualToString:@"stop"]) {
        dispatch_sync(gWriterQueue, ^{ ClearClip(); });
        return StatusReply();
    }

    if ([action isEqualToString:@"setIdle"]) {
        NSString *mode = [cmd[@"mode"] isKindOfClass:NSString.class] ? cmd[@"mode"] : @"";
        uint32_t code;
        if ([mode isEqualToString:@"silence"]) code = SIMMIC_IDLE_SILENCE;
        else if ([mode isEqualToString:@"passthrough"]) code = SIMMIC_IDLE_PASSTHROUGH;
        else return @{@"ok": @NO, @"error": @"mode must be silence or passthrough"};
        atomic_store(&gHeader->idleMode, code);
        return StatusReply();
    }

    if ([action isEqualToString:@"shutdown"]) {
        gShouldExit = 1;
        return @{@"ok": @YES};
    }

    return @{@"ok": @NO, @"error": [NSString stringWithFormat:@"unknown action: %@", action]};
}

static void Reply(int fd, NSDictionary *reply) {
    NSMutableData *data = [[NSJSONSerialization dataWithJSONObject:reply options:0 error:NULL] mutableCopy];
    [data appendBytes:"\n" length:1];
    const uint8_t *bytes = data.bytes;
    size_t left = data.length;
    while (left > 0) {
        ssize_t n = write(fd, bytes, left);
        if (n <= 0) break;
        bytes += n;
        left -= (size_t)n;
    }
}

static void HandleClient(int fd) {
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        NSMutableData *buf = [NSMutableData new];
        char tmp[1024];
        while (1) {
            ssize_t n = read(fd, tmp, sizeof(tmp));
            if (n <= 0) break;
            [buf appendBytes:tmp length:(NSUInteger)n];
            while (1) {
                const char *start = buf.bytes;
                const char *nl = memchr(start, '\n', buf.length);
                if (!nl) break;
                NSData *line = [buf subdataWithRange:NSMakeRange(0, (NSUInteger)(nl - start))];
                [buf replaceBytesInRange:NSMakeRange(0, (NSUInteger)(nl - start) + 1) withBytes:NULL length:0];
                if (line.length == 0) continue;
                id cmd = [NSJSONSerialization JSONObjectWithData:line options:0 error:NULL];
                @autoreleasepool {
                    Reply(fd, [cmd isKindOfClass:NSDictionary.class]
                                  ? HandleCommand(cmd)
                                  : @{@"ok": @NO, @"error": @"invalid JSON"});
                }
            }
        }
        close(fd);
    });
}

#pragma mark - Setup

static int OpenControlSocket(const char *path) {
    unlink(path);
    int fd = socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) { perror("socket"); return -1; }
    struct sockaddr_un addr = {.sun_family = AF_UNIX};
    if (strlen(path) >= sizeof(addr.sun_path)) {
        LOG("control socket path too long: %s", path);
        close(fd);
        return -1;
    }
    strlcpy(addr.sun_path, path, sizeof(addr.sun_path));
    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) < 0) { perror("bind"); close(fd); return -1; }
    if (listen(fd, 4) < 0) { perror("listen"); close(fd); return -1; }
    chmod(path, 0600);
    gListenFd = fd;
    gAcceptSource = dispatch_source_create(DISPATCH_SOURCE_TYPE_READ, (uintptr_t)fd, 0,
                                           dispatch_get_global_queue(QOS_CLASS_UTILITY, 0));
    dispatch_source_set_event_handler(gAcceptSource, ^{
        int client = accept(fd, NULL, NULL);
        if (client >= 0) HandleClient(client);
    });
    dispatch_resume(gAcceptSource);
    return fd;
}

static BOOL OpenShm(const char *name, uint32_t idleMode) {
    size_t size = (size_t)SimMicRegionSize(SIMMIC_CAPACITY_FRAMES);
    shm_unlink(name);
    int fd = shm_open(name, O_CREAT | O_RDWR, 0644);
    if (fd < 0) { perror("shm_open"); return NO; }
    if (ftruncate(fd, (off_t)size) < 0) { perror("ftruncate"); close(fd); return NO; }
    void *map = mmap(NULL, size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (map == MAP_FAILED) { perror("mmap"); return NO; }
    memset(map, 0, size);
    gHeader = map;
    gRing = (float *)((uint8_t *)map + SIMMIC_SAMPLES_OFFSET);
    gHeader->version = SIMMIC_VERSION;
    gHeader->sampleRate = SIMMIC_SAMPLE_RATE;
    gHeader->capacityFrames = SIMMIC_CAPACITY_FRAMES;
    uint64_t session = 0;
    while (session == 0) arc4random_buf(&session, sizeof(session));
    gHeader->sessionId = session;
    atomic_store(&gHeader->idleMode, idleMode);
    // Magic last: readers ignore the region until the header is complete.
    atomic_thread_fence(memory_order_release);
    gHeader->magic = SIMMIC_SHM_MAGIC;
    return YES;
}

static void HandleSignal(int sig) {
    (void)sig;
    gShouldExit = 1;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        const char *socketPath = NULL;
        uint32_t idleMode = SIMMIC_IDLE_SILENCE;
        for (int i = 1; i < argc; i++) {
            const char *a = argv[i];
            if (!strcmp(a, "--shm") && i + 1 < argc) gShmName = argv[++i];
            else if (!strcmp(a, "--socket") && i + 1 < argc) socketPath = argv[++i];
            else if (!strcmp(a, "--idle") && i + 1 < argc) {
                idleMode = !strcmp(argv[++i], "passthrough") ? SIMMIC_IDLE_PASSTHROUGH : SIMMIC_IDLE_SILENCE;
            } else if (!strcmp(a, "--help") || !strcmp(a, "-h")) {
                printf("Usage: %s --shm <name> --socket <path> [--idle silence|passthrough]\n", argv[0]);
                return 0;
            }
        }
        if (!gShmName || !socketPath) {
            fprintf(stderr, "error: --shm <name> and --socket <path> are required\n");
            return 64;
        }
        if (!OpenShm(gShmName, idleMode)) return 1;
        StartWriter();
        if (OpenControlSocket(socketPath) < 0) {
            shm_unlink(gShmName);
            return 1;
        }
        signal(SIGINT, HandleSignal);
        signal(SIGTERM, HandleSignal);
        LOG("streaming to shm \"%s\" (%u Hz mono), control socket %s, idle %s", gShmName,
            SIMMIC_SAMPLE_RATE, socketPath, IdleName(idleMode).UTF8String);

        while (!gShouldExit) {
            [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.2]];
        }
        if (gAcceptSource) dispatch_source_cancel(gAcceptSource);
        if (gListenFd >= 0) close(gListenFd);
        unlink(socketPath);
        shm_unlink(gShmName);
        LOG("stopped");
        return 0;
    }
}
