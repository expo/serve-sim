// Per-app proxy for network capture. Injected at app launch (SIMCTL_CHILD_DYLD_INSERT_LIBRARIES) and sets
// `connectionProxyDictionary` on that process's URL sessions, so nothing outside the app is affected.
//
// Not covered: traffic that bypasses NSURLSession, and sessions built before this library loads.

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
    // Picked up by `simctl spawn <udid> log stream`, and by Console, under this subsystem.
    NSLog(@"[simnetproxy] %@", message);
}

/**
 * The proxy settings CFNetwork honors for a single session.
 *
 * The HTTP keys are the documented CFNetwork constants. The HTTPS ones have no public constants on iOS,
 * so the literal keys CFNetwork looks for are used directly; without them only cleartext HTTP would be
 * proxied, which for a modern app means almost nothing.
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

/**
 * The port, read from the file the proxy wrote.
 *
 * A path rather than a number, because the file lives in the proxy's own directory and is removed whenever
 * the proxy dies — including on a signal, where no cleanup code of ours gets to run. An app launched after
 * that finds nothing here and stays unproxied, instead of trusting a port number that some unrelated
 * process may have since bound.
 */
static long SimNetProxyPortFromFile(const char *path) {
    FILE *handle = fopen(path, "r");
    if (handle == NULL) return 0;
    char buffer[32] = {0};
    size_t read = fread(buffer, 1, sizeof(buffer) - 1, handle);
    fclose(handle);
    return read > 0 ? atol(buffer) : 0;
}

/**
 * Whether anything is actually listening on the proxy port.
 *
 * The app keeps whatever port it was launched with for its whole life, and capture sessions come and
 * go. Relaunching a previously-captured app while capture is off would otherwise install a proxy nobody
 * is serving, and every request in the app would fail to connect with no explanation. Checking once at
 * launch costs a loopback connect and makes that case come up working instead.
 */
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
    // Reaches the original implementation: the selectors were exchanged.
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

#pragma mark - Entry point

__attribute__((constructor))
static void SimNetProxyInit(void) {
    @autoreleasepool {
        // The file is what a device booted for capture is given. The bare port remains for a caller that
        // applies the library to a single launch itself.
        const char *portFile = getenv("SIMNET_PROXY_PORT_FILE");
        const char *port = getenv("SIMNET_PROXY_PORT");
        long candidate = portFile != NULL ? SimNetProxyPortFromFile(portFile)
                                          : (port != NULL ? atol(port) : 0);
        if (candidate <= 0) {
            // Nothing to do: the app was launched without capture enabled, or the proxy is gone.
            return;
        }
        if (!SimNetProxyPortIsListening(candidate)) {
            // A stale launch: this app was captured before, but that session is gone. Leave its
            // networking alone rather than pointing it at a port nobody answers.
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

        // `+[NSURLSession sharedSession]` is built before anything can swizzle it, so its proxy cannot be
        // set retroactively. That gap was measured rather than assumed: across React Native and the Expo
        // native modules, every session is built from `defaultSessionConfiguration` (RN's own
        // RCTHTTPRequestHandler included), nothing constructs a configuration with `new`/`alloc`, and the
        // only `sharedSession` user is expo-dev-launcher fetching manifests — launcher infrastructure
        // rather than app traffic. Logged anyway, because an app that used it exclusively would otherwise
        // look like an app making no requests at all.
        simnet_log(@"loaded into pid %d, proxy %@:%ld, swizzles %@",
                   getpid(), kSimNetProxyHost, simNetProxyPort, ok ? @"installed" : @"INCOMPLETE");
    }
}
