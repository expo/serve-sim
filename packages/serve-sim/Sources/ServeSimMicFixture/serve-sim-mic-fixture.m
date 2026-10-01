// Fixture app for the mic tests. Records with the API picked by the `mode`
// user default (engine, queue or vpio) and appends the input RMS every
// 250 ms to Documents/levels.tsv, so a test can read back what the app heard.

#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#import <UIKit/UIKit.h>

static NSString *gMode = @"engine";
static double gSumSquares;
static uint64_t gFrames;
static AudioUnit gUnit;

static void Record(NSString *kind, NSString *detail) {
  NSArray<NSString *> *dirs =
      NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *path = [dirs.firstObject stringByAppendingPathComponent:@"levels.tsv"];
  NSString *line = [NSString stringWithFormat:@"%@\t%@\t%@\n", kind, gMode, detail];
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
  if (handle == nil) {
    [line writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    return;
  }
  [handle seekToEndOfFile];
  [handle writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
  [handle closeFile];
}

static void Accumulate(const float *samples, UInt32 count) {
  for (UInt32 i = 0; i < count; i++) gSumSquares += (double)samples[i] * samples[i];
  gFrames += count;
}

static void QueueCallback(void *ref, AudioQueueRef queue, AudioQueueBufferRef buffer,
                          const AudioTimeStamp *time, UInt32 packets,
                          const AudioStreamPacketDescription *descriptions) {
  (void)ref; (void)time; (void)packets; (void)descriptions;
  Accumulate(buffer->mAudioData, buffer->mAudioDataByteSize / sizeof(float));
  AudioQueueEnqueueBuffer(queue, buffer, 0, NULL);
}

static OSStatus UnitCallback(void *ref, AudioUnitRenderActionFlags *flags, const AudioTimeStamp *time,
                             UInt32 bus, UInt32 frames, AudioBufferList *unused) {
  (void)ref; (void)bus; (void)unused;
  static float samples[8192];
  if (frames > 8192) return noErr;
  AudioBufferList list = {1, {{1, (UInt32)(frames * sizeof(float)), samples}}};
  OSStatus status = AudioUnitRender(gUnit, flags, time, 1, frames, &list);
  if (status == noErr) Accumulate(samples, frames);
  return status;
}

static AudioStreamBasicDescription MonoFloat(double rate) {
  AudioStreamBasicDescription format = {0};
  format.mSampleRate = rate;
  format.mFormatID = kAudioFormatLinearPCM;
  format.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
  format.mChannelsPerFrame = 1;
  format.mBitsPerChannel = 32;
  format.mBytesPerFrame = 4;
  format.mFramesPerPacket = 1;
  format.mBytesPerPacket = 4;
  return format;
}

@interface FixtureDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) AVAudioEngine *engine;
@end

@implementation FixtureDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [UIViewController new];
  self.window.rootViewController.view.backgroundColor = UIColor.systemIndigoColor;
  [self.window makeKeyAndVisible];

  // A `-mode` launch argument or `defaults write <bundle> mode <name>`.
  NSString *mode = [NSUserDefaults.standardUserDefaults stringForKey:@"mode"];
  if (mode.length > 0) gMode = mode;

  AVAudioSession *session = AVAudioSession.sharedInstance;
  [session setCategory:AVAudioSessionCategoryPlayAndRecord error:NULL];
  [session setActive:YES error:NULL];
  [AVAudioApplication requestRecordPermissionWithCompletionHandler:^(BOOL granted) {
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!granted) { Record(@"error", @"permission denied"); return; }
      [self startRecording];
    });
  }];
  return YES;
}

- (void)startRecording {
  OSStatus status = noErr;
  if ([gMode isEqualToString:@"queue"]) {
    AudioStreamBasicDescription format = MonoFloat(44100);
    AudioQueueRef queue;
    status = AudioQueueNewInput(&format, QueueCallback, NULL, NULL, NULL, 0, &queue);
    for (int i = 0; i < 3 && status == noErr; i++) {
      AudioQueueBufferRef buffer;
      AudioQueueAllocateBuffer(queue, 4096, &buffer);
      AudioQueueEnqueueBuffer(queue, buffer, 0, NULL);
    }
    if (status == noErr) status = AudioQueueStart(queue, NULL);
  } else if ([gMode isEqualToString:@"vpio"]) {
    AudioComponentDescription description = {kAudioUnitType_Output, kAudioUnitSubType_VoiceProcessingIO,
                                              kAudioUnitManufacturer_Apple, 0, 0};
    status = AudioComponentInstanceNew(AudioComponentFindNext(NULL, &description), &gUnit);
    UInt32 on = 1, off = 0;
    AudioStreamBasicDescription format = MonoFloat(48000);
    AURenderCallbackStruct callback = {UnitCallback, NULL};
    if (status == noErr) status = AudioUnitSetProperty(gUnit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &on, sizeof(on));
    if (status == noErr) status = AudioUnitSetProperty(gUnit, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &off, sizeof(off));
    if (status == noErr) status = AudioUnitSetProperty(gUnit, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 1, &format, sizeof(format));
    if (status == noErr) status = AudioUnitSetProperty(gUnit, kAudioOutputUnitProperty_SetInputCallback, kAudioUnitScope_Global, 0, &callback, sizeof(callback));
    if (status == noErr) status = AudioUnitInitialize(gUnit);
    if (status == noErr) status = AudioOutputUnitStart(gUnit);
  } else {
    self.engine = [AVAudioEngine new];
    AVAudioInputNode *input = self.engine.inputNode;
    [input installTapOnBus:0 bufferSize:4096 format:[input outputFormatForBus:0]
                     block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                       (void)when;
                       Accumulate(buffer.floatChannelData[0], buffer.frameLength);
                     }];
    NSError *error = nil;
    if (![self.engine startAndReturnError:&error]) status = (OSStatus)error.code;
  }
  if (status != noErr) { Record(@"error", [NSString stringWithFormat:@"status %d", (int)status]); return; }
  Record(@"start", [NSString stringWithFormat:@"%d", getpid()]);

  [NSTimer scheduledTimerWithTimeInterval:0.25 repeats:YES block:^(NSTimer *timer) {
    (void)timer;
    double rms = gFrames ? sqrt(gSumSquares / (double)gFrames) : 0;
    Record(@"level", [NSString stringWithFormat:@"%.5f", rms]);
    gSumSquares = 0;
    gFrames = 0;
  }];
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(FixtureDelegate.class));
  }
}
