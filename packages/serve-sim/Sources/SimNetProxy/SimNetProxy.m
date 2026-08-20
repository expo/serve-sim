// Per-app NSURLSession proxy for network capture.

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <sys/socket.h>

static NSString *const kSimNetProxyHost = @"127.0.0.1";
static long simNetProxyPort = 0;

static void simnet_log(NSString *format, ...) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);
    NSLog(@"[simnetproxy] %@", message);
}

/**
 * HTTPS has no public iOS constants — literal keys CFNetwork expects;
 * without them only cleartext is proxied.
 */
static NSDictionary *SimNetProxyDictionary(void) {
    return @{
        (NSString *)kCFNetworkProxiesHTTPEnable : @YES,
        (NSString *)kCFNetworkProxiesHTTPProxy : kSimNetProxyHost,
        (NSString *)kCFNetworkProxiesHTTPPort : @(simNetProxyPort),
        @"HTTPSEnable" : @YES,
        @"HTTPSProxy" : kSimNetProxyHost,
        @"HTTPSPort" : @(simNetProxyPort),
    };
}

/** Port file dies with the proxy, so a stale launch finds nothing. */
static long SimNetProxyPortFromFile(const char *path) {
    FILE *handle = fopen(path, "r");
    if (handle == NULL) return 0;
    char buffer[32] = {0};
    size_t read = fread(buffer, 1, sizeof(buffer) - 1, handle);
    fclose(handle);
    return read > 0 ? atol(buffer) : 0;
}

static BOOL SimNetProxyPortIsListening(long port) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return NO;
    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    BOOL reachable = connect(fd, (struct sockaddr *)&addr, sizeof(addr)) == 0;
    close(fd);
    return reachable;
}

static void SimNetProxyApply(NSURLSessionConfiguration *configuration) {
    if (configuration == nil || simNetProxyPort <= 0) return;
    configuration.connectionProxyDictionary = SimNetProxyDictionary();
}

#pragma mark - Swizzles

@interface NSURLSessionConfiguration (SimNetProxy)
@end

@implementation NSURLSessionConfiguration (SimNetProxy)

+ (NSURLSessionConfiguration *)simnet_defaultSessionConfiguration {
    NSURLSessionConfiguration *configuration = [self simnet_defaultSessionConfiguration];
    SimNetProxyApply(configuration);
    return configuration;
}

+ (NSURLSessionConfiguration *)simnet_ephemeralSessionConfiguration {
    NSURLSessionConfiguration *configuration = [self simnet_ephemeralSessionConfiguration];
    SimNetProxyApply(configuration);
    return configuration;
}

+ (NSURLSessionConfiguration *)simnet_backgroundSessionConfigurationWithIdentifier:(NSString *)identifier {
    NSURLSessionConfiguration *configuration =
        [self simnet_backgroundSessionConfigurationWithIdentifier:identifier];
    SimNetProxyApply(configuration);
    return configuration;
}

@end

static BOOL SwizzleClassMethod(Class cls, SEL orig, SEL swiz) {
    Method o = class_getClassMethod(cls, orig);
    Method s = class_getClassMethod(cls, swiz);
    if (!o || !s) {
        simnet_log(@"swizzle FAILED: +[%@ %@]", NSStringFromClass(cls), NSStringFromSelector(orig));
        return NO;
    }
    method_exchangeImplementations(o, s);
    return YES;
}

/** Apple system apps (Safari, SpringBoard, …) break under MITM — AppSSO/AuthKit hang the main thread. */
static BOOL SimNetProxyShouldSkipProcess(void) {
    NSString *bundleId = NSBundle.mainBundle.bundleIdentifier;
    if (bundleId.length == 0) {
        // XPC helpers / no bundle — leave them alone.
        return YES;
    }
    if ([bundleId hasPrefix:@"com.apple."]) {
        return YES;
    }
    return NO;
}

#pragma mark - Entry point

__attribute__((constructor))
static void SimNetProxyInit(void) {
    @autoreleasepool {
        if (SimNetProxyShouldSkipProcess()) {
            return;
        }
        // Port file is the boot-capture path; bare port remains for a single-launch inject.
        const char *portFile = getenv("SIMNET_PROXY_PORT_FILE");
        const char *port = getenv("SIMNET_PROXY_PORT");
        long candidate = portFile != NULL ? SimNetProxyPortFromFile(portFile)
                                          : (port != NULL ? atol(port) : 0);
        if (candidate <= 0) {
            return;
        }
        if (!SimNetProxyPortIsListening(candidate)) {
            simnet_log(@"proxy %ld is not listening; leaving this app unproxied", candidate);
            return;
        }
        simNetProxyPort = candidate;

        Class cls = NSURLSessionConfiguration.class;
        BOOL ok = YES;
        ok &= SwizzleClassMethod(cls, @selector(defaultSessionConfiguration),
                                @selector(simnet_defaultSessionConfiguration));
        ok &= SwizzleClassMethod(cls, @selector(ephemeralSessionConfiguration),
                                @selector(simnet_ephemeralSessionConfiguration));
        ok &= SwizzleClassMethod(cls, @selector(backgroundSessionConfigurationWithIdentifier:),
                                @selector(simnet_backgroundSessionConfigurationWithIdentifier:));

        // `sharedSession` is built too early to swizzle.
        simnet_log(@"loaded into pid %d (%@), proxy %@:%ld, swizzles %@",
                   getpid(), NSBundle.mainBundle.bundleIdentifier ?: @"?", kSimNetProxyHost, simNetProxyPort,
                   ok ? @"installed" : @"INCOMPLETE");
    }
}
