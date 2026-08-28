#import "SimFpsLog.h"

void simfps_log(NSString *fmt, ...) {
    va_list args; va_start(args, fmt);
    NSString *msg = [[NSString alloc] initWithFormat:fmt arguments:args];
    va_end(args);
    fprintf(stderr, "[SimFps] %s\n", msg.UTF8String);
    NSLog(@"[SimFps] %@", msg);
}
