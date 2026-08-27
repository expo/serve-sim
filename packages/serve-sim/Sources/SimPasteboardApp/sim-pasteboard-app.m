#import <UIKit/UIKit.h>

// Reads the simulator pasteboard and writes it to Documents/pasteboard.txt.
//
// iOS only serves pasteboard contents to a foreground app, so this has to be a
// real app rather than a `simctl spawn` helper. The read is silent once the app
// holds kTCCServicePasteboard (`simctl privacy <udid> grant pasteboard`);
// without it iOS puts up a consent alert instead.
static NSString *documentsPath(NSString *name) {
  NSArray<NSString *> *dirs =
      NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES);
  return [dirs.firstObject stringByAppendingPathComponent:name];
}

@interface SimPasteboardAppDelegate : UIResponder <UIApplicationDelegate>
@end

@implementation SimPasteboardAppDelegate
@synthesize window;

- (BOOL)application:(UIApplication *)application
    didFinishLaunchingWithOptions:(NSDictionary *)options {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [UIViewController new];
  self.window.rootViewController.view.backgroundColor = UIColor.clearColor;
  [self.window makeKeyAndVisible];
  return YES;
}

- (void)applicationDidBecomeActive:(UIApplication *)application {
  NSString *text = UIPasteboard.generalPasteboard.string ?: @"";
  NSError *error = nil;
  [text writeToFile:documentsPath(@"pasteboard.txt")
         atomically:YES
           encoding:NSUTF8StringEncoding
              error:&error];
  // The marker is written last so a reader never sees a half-written value.
  [@"1" writeToFile:documentsPath(@"done")
         atomically:YES
           encoding:NSUTF8StringEncoding
              error:NULL];
  exit(error ? 1 : 0);
}
@end

int main(int argc, char **argv) {
  @autoreleasepool {
    return UIApplicationMain(argc, argv, nil, NSStringFromClass(SimPasteboardAppDelegate.class));
  }
}
