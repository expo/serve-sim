// A minimal app whose only job is to make one NSURLSession request, so a test can prove the injected
// SimNetProxy dylib actually routes that request through the capture proxy.
//
// The request is built from `defaultSessionConfiguration` because that is the path the dylib swizzles,
// and it is the path React Native and the Expo modules use.

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
                                     completionHandler:^(NSData *data, NSURLResponse *response,
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
