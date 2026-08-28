#import <UIKit/UIKit.h>
#import <QuartzCore/QuartzCore.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <stdatomic.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#import "SimFpsLog.h"
#include "SimFpsShared.h"

typedef unsigned int (*SimFpsRenderCounter)(unsigned int);

@interface SimFpsProbe : NSObject
@property(nonatomic, strong) CADisplayLink *link;
@property(nonatomic, assign) NSInteger frames;
@property(nonatomic, assign) CFTimeInterval windowStart;
@property(nonatomic, assign) NSInteger nominalMax;
@property(nonatomic, assign) SimFpsRenderCounter renderCounter;
@property(nonatomic, assign) unsigned int lastRenderFrame;
@property(nonatomic, assign) SimFpsShmHeader *shm;
@property(nonatomic, copy) NSString *bundleId;
@end

@implementation SimFpsProbe

- (void)mapShm {
    if (self.shm) return;
    const char *name = getenv("SERVE_SIM_FPS_SHM");
    if (!name || !*name) return;
    int fd = shm_open(name, O_CREAT | O_RDWR, 0644);
    if (fd < 0) {
        simfps_log(@"shm_open(%s) failed", name);
        return;
    }
    if (ftruncate(fd, (off_t)SIMFPS_SHM_SIZE) != 0) {
        simfps_log(@"ftruncate(%s) failed", name);
        close(fd);
        return;
    }
    void *map = mmap(NULL, SIMFPS_SHM_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (map == MAP_FAILED) {
        simfps_log(@"mmap(%s) failed", name);
        return;
    }
    SimFpsShmHeader *hdr = (SimFpsShmHeader *)map;
    if (hdr->magic != SIMFPS_SHM_MAGIC || hdr->version != SIMFPS_SHM_VERSION) {
        memset(hdr, 0, SIMFPS_SHM_SIZE);
        hdr->magic = SIMFPS_SHM_MAGIC;
        hdr->version = SIMFPS_SHM_VERSION;
    }
    self.shm = hdr;
    simfps_log(@"shm %s attached", name);
}

- (void)start {
    self.frames = 0;
    self.windowStart = 0;
    self.nominalMax = UIScreen.mainScreen.maximumFramesPerSecond;
    self.renderCounter = (SimFpsRenderCounter)dlsym(RTLD_DEFAULT, "CARenderServerGetFrameCounter");
    self.bundleId = NSBundle.mainBundle.bundleIdentifier ?: @"";
    [self mapShm];
    self.link = [CADisplayLink displayLinkWithTarget:self selector:@selector(tick:)];
    [self.link addToRunLoop:[NSRunLoop mainRunLoop] forMode:NSRunLoopCommonModes];
    simfps_log(@"probe started (pid %d, max %ld fps, renderCounter %s)",
               getpid(), (long)self.nominalMax, self.renderCounter ? "yes" : "no");
}

- (void)tick:(CADisplayLink *)link {
    if (self.windowStart == 0) {
        self.windowStart = link.timestamp;
        self.lastRenderFrame = self.renderCounter ? self.renderCounter(0) : 0;
    }
    self.frames++;
    CFTimeInterval elapsed = link.timestamp - self.windowStart;
    if (elapsed < 1.0) return;
    double mainFps = self.frames / elapsed;
    double renderFps = mainFps;
    if (self.renderCounter) {
        unsigned int now = self.renderCounter(0);
        renderFps = (unsigned int)(now - self.lastRenderFrame) / elapsed;
        self.lastRenderFrame = now;
    }
    [self emitRender:renderFps main:mainFps];
    self.frames = 0;
    self.windowStart = link.timestamp;
}

- (void)emitRender:(double)renderFps main:(double)mainFps {
    [self mapShm];
    SimFpsShmHeader *hdr = self.shm;
    if (!hdr) return;

    uint32_t seq = hdr->seq;
    if (seq & 1u) seq += 1;
    hdr->seq = seq + 1;
    atomic_thread_fence(memory_order_release);

    hdr->fps = (float)renderFps;
    hdr->mainThreadFps = (float)mainFps;
    hdr->nominalMax = (uint32_t)self.nominalMax;
    hdr->timestampMs = (uint64_t)(NSDate.date.timeIntervalSince1970 * 1000);
    memset(hdr->bundleId, 0, SIMFPS_BUNDLE_ID_MAX);
    NSString *bid = self.bundleId;
    if (bid.length > 0) {
        [bid getCString:hdr->bundleId maxLength:SIMFPS_BUNDLE_ID_MAX encoding:NSUTF8StringEncoding];
    }

    atomic_thread_fence(memory_order_release);
    hdr->seqCopy = seq + 2;
    hdr->seq = seq + 2;
}

@end

static SimFpsProbe *gSimFpsProbe;

__attribute__((constructor))
static void SimFpsProbeInit(void) {
    @autoreleasepool {
        simfps_log(@"loaded into pid %d", getpid());
        dispatch_async(dispatch_get_main_queue(), ^{
            gSimFpsProbe = [SimFpsProbe new];
            [gSimFpsProbe start];
        });
    }
}
