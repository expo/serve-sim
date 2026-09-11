// Fixture app for the launch tests. Records every launch and opened URL in its
// own data container so a test can read back what the launch carried.
// UIKit puts the app on the scene lifecycle, so URLs arrive at the scene
// delegate; the app delegate never sees them.

#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>

static void Record(NSString *kind, NSString *detail) {
  NSArray<NSString *> *dirs =
      NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  NSString *path = [dirs.firstObject stringByAppendingPathComponent:@"launches.tsv"];
  NSString *line = [NSString stringWithFormat:@"%@\t%d\t%@\n", kind, getpid(), detail];

  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
  if (handle == nil) {
    [line writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:NULL];
    return;
  }
  [handle seekToEndOfFile];
  [handle writeData:[line dataUsingEncoding:NSUTF8StringEncoding]];
  [handle closeFile];
}

static void RecordURLContexts(NSSet<UIOpenURLContext *> *contexts) {
  for (UIOpenURLContext *context in contexts) {
    Record(@"openurl", context.URL.absoluteString);
  }
}

// Recorded from +load so a launch that is terminated before
// didFinishLaunchingWithOptions still leaves a trace.
@interface FixtureStartRecorder : NSObject
@end

@implementation FixtureStartRecorder

+ (void)load {
  Record(@"start", @"");
}

@end

@interface QueuedFrameRecorder : NSObject <AVCaptureVideoDataOutputSampleBufferDelegate>
@end

@implementation QueuedFrameRecorder
- (void)captureOutput:(AVCaptureOutput *)output
 didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
        fromConnection:(AVCaptureConnection *)connection {
  dispatch_async(dispatch_get_main_queue(), ^{ Record(@"queued-sample", @""); });
}
@end

@interface FixtureSceneDelegate : UIResponder <UIWindowSceneDelegate, AVCaptureVideoDataOutputSampleBufferDelegate>
@property(nonatomic, strong) UIWindow *window;
@property(nonatomic, strong) AVCaptureSession *session;
@property(nonatomic, strong) AVCaptureVideoPreviewLayer *preview;
@property(nonatomic, copy) NSString *lastPixel;
@property(nonatomic, strong) AVCaptureVideoDataOutput *queuedOutput;
@property(nonatomic, strong) QueuedFrameRecorder *queuedRecorder;
@property(nonatomic, strong) dispatch_queue_t queuedFrames;
@end

@implementation FixtureSceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
                 options:(UISceneConnectionOptions *)connectionOptions {
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  self.window.rootViewController = [[UIViewController alloc] init];
  self.window.rootViewController.view.backgroundColor = UIColor.systemGreenColor;
  [self.window makeKeyAndVisible];
  UIView *root = self.window.rootViewController.view;
  Record(@"permission", [NSString stringWithFormat:@"%ld", (long)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]]);
  [self showCameraIn:root];
  [NSNotificationCenter.defaultCenter addObserverForName:AVCaptureDeviceWasConnectedNotification
                                                  object:nil
                                                   queue:NSOperationQueue.mainQueue
                                              usingBlock:^(NSNotification *note) {
    Record(@"connected", ((AVCaptureDevice *)note.object).uniqueID);
    if (self.session == nil) [self showCameraIn:root];
  }];
  [NSNotificationCenter.defaultCenter addObserverForName:AVCaptureDeviceWasDisconnectedNotification
                                                  object:nil
                                                   queue:NSOperationQueue.mainQueue
                                              usingBlock:^(NSNotification *note) {
    AVCaptureDevice *device = note.object;
    AVCaptureDevice *legacy = [AVCaptureDevice defaultDeviceWithMediaType:AVMediaTypeVideo];
    Record(@"disconnected", [NSString stringWithFormat:@"connected=%d legacy=%d devices=%lu permission=%ld",
        device.isConnected, legacy != nil,
        (unsigned long)[AVCaptureDeviceDiscoverySession discoverySessionWithDeviceTypes:@[AVCaptureDeviceTypeBuiltInWideAngleCamera] mediaType:AVMediaTypeVideo position:AVCaptureDevicePositionUnspecified].devices.count,
        (long)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeVideo]]);
    [self.session stopRunning];
    self.session = nil;
    [self.preview removeFromSuperlayer];
    self.preview = nil;
    self.lastPixel = nil;
    if (self.queuedFrames) {
      dispatch_queue_t queue = self.queuedFrames;
      self.queuedFrames = nil;
      dispatch_resume(queue);
      dispatch_async(queue, ^{
        dispatch_async(dispatch_get_main_queue(), ^{ Record(@"queue-drained", @""); });
      });
    }
  }];
  // Opening the camera later than the trampoline's load delay, to tell a
  // capability that arrived late from one that never arrived.
  if ([NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixtureCameraLate"]) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3 * NSEC_PER_SEC)),
                   dispatch_get_main_queue(), ^{ [self showCameraIn:root]; });
  }
  RecordURLContexts(connectionOptions.URLContexts);
}

// Records what it saw either way, so a test can assert the feed without
// looking at a screenshot.
- (void)showCameraIn:(UIView *)view {
  AVCaptureDevice *device =
      [AVCaptureDevice defaultDeviceWithDeviceType:AVCaptureDeviceTypeBuiltInWideAngleCamera
                                         mediaType:AVMediaTypeVideo
                                          position:AVCaptureDevicePositionBack];
  if (device == nil) {
    Record(@"camera", @"no device");
    return;
  }

  NSError *error = nil;
  AVCaptureDeviceInput *input = [AVCaptureDeviceInput deviceInputWithDevice:device error:&error];
  AVCaptureSession *session = [[AVCaptureSession alloc] init];
  if (input == nil || ![session canAddInput:input]) {
    Record(@"camera", error.localizedDescription ?: @"input refused");
    return;
  }
  [session addInput:input];
  AVCaptureVideoDataOutput *output = [AVCaptureVideoDataOutput new];
  [output setSampleBufferDelegate:self queue:dispatch_get_main_queue()];
  [session addOutput:output];

  // Assigning the session goes through setSession:, which is where serve-sim
  // hooks the preview. layerWithSession: sets it without that.
  AVCaptureVideoPreviewLayer *preview = [[AVCaptureVideoPreviewLayer alloc] init];
  preview.session = session;
  preview.videoGravity = AVLayerVideoGravityResizeAspectFill;
  preview.frame = view.bounds;
  [view.layer addSublayer:preview];
  self.session = session;
  self.preview = preview;
  self.lastPixel = nil;

  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    [session startRunning];
  });
  Record(@"camera", device.localizedName);
}

- (void)captureOutput:(AVCaptureOutput *)output
 didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
        fromConnection:(AVCaptureConnection *)connection {
  CVPixelBufferRef pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer);
  CVPixelBufferLockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
  const unsigned char *pixel = (const unsigned char *)CVPixelBufferGetBaseAddress(pixelBuffer)
      + (CVPixelBufferGetHeight(pixelBuffer) / 2) * CVPixelBufferGetBytesPerRow(pixelBuffer)
      + (CVPixelBufferGetWidth(pixelBuffer) / 2) * 4;
  Record(@"sample", @"");
  if (!self.queuedOutput && [NSProcessInfo.processInfo.arguments containsObject:@"-ServeSimFixtureQueuedFrames"]) {
    self.queuedOutput = [AVCaptureVideoDataOutput new];
    self.queuedRecorder = [QueuedFrameRecorder new];
    self.queuedFrames = dispatch_queue_create("fixture.queued-frames", DISPATCH_QUEUE_SERIAL);
    dispatch_suspend(self.queuedFrames);
    [self.queuedOutput setSampleBufferDelegate:self.queuedRecorder queue:self.queuedFrames];
    Record(@"queue-suspended", @"");
  }
  NSString *value = [NSString stringWithFormat:@"%u,%u,%u", pixel[2], pixel[1], pixel[0]];
  if (![value isEqualToString:self.lastPixel]) {
    Record(@"frame", value);
    self.lastPixel = value;
  }
  CVPixelBufferUnlockBaseAddress(pixelBuffer, kCVPixelBufferLock_ReadOnly);
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts {
  RecordURLContexts(URLContexts);
}

@end

@interface FixtureAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation FixtureAppDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)options {
  NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
  NSArray<NSString *> *passed = arguments.count > 1
      ? [arguments subarrayWithRange:NSMakeRange(1, arguments.count - 1)]
      : @[];
  Record(@"launch", [passed componentsJoinedByString:@"\x1f"]);
  return YES;
}

- (UISceneConfiguration *)application:(UIApplication *)application
    configurationForConnectingSceneSession:(UISceneSession *)session
                                   options:(UISceneConnectionOptions *)options {
  UISceneConfiguration *configuration =
      [UISceneConfiguration configurationWithName:nil sessionRole:session.role];
  configuration.delegateClass = FixtureSceneDelegate.class;
  return configuration;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(FixtureAppDelegate.class));
  }
}
