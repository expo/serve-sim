// Exercise the configuration factory used by the capture swizzle.

#import <UIKit/UIKit.h>

@interface SimNetProbeDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@end

@implementation SimNetProbeDelegate

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [UIViewController new];
  [self.window makeKeyAndVisible];

  const char *target = getenv("SIMNET_PROBE_URL");
  NSString *urlString = target != NULL ? @(target) : @"https://simnet-probe.test/ping";

  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.defaultSessionConfiguration;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
  NSURLSessionDataTask *task = [session dataTaskWithURL:[NSURL URLWithString:urlString]
                                     completionHandler:^(__unused NSData *data,
                                                         __unused NSURLResponse *response,
                                                         NSError *error) {
                                       NSLog(@"[simnetprobe] done error=%@",
                                             error.localizedDescription ?: @"none");
                                     }];
  [task resume];
  return YES;
}

@end

int main(int argc, char *argv[]) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(SimNetProbeDelegate.class));
  }
}
