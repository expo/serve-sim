#import <UIKit/UIKit.h>

// Writes stdin to the simulator's general pasteboard.
//
// `simctl pbcopy` bridges the host pasteboard into the simulator and needs a
// GUI login session, so it segfaults on headless hosts such as EAS workers.
// Running inside the simulator talks to pasteboardd directly and works either
// way. Reading is not offered: iOS only serves pasteboard contents to a
// foreground app, so a spawned process always reads back nil.
int main(void) {
  @autoreleasepool {
    NSData *data = [NSFileHandle.fileHandleWithStandardInput readDataToEndOfFile];
    NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if (!text) {
      fputs("stdin was not valid UTF-8\n", stderr);
      return 1;
    }

    UIPasteboard.generalPasteboard.string = text;
    // The write reaches pasteboardd over XPC, so let the run loop turn before
    // exiting or it is dropped.
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.25]];
    return 0;
  }
}
