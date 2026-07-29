// Per-app proxy for network capture.
//
// An iOS simulator has no network configuration of its own; it reads the host's. Pointing a simulator at
// a capture proxy therefore used to mean setting the *machine's* system proxy, which sends every process
// on the developer's Mac through it and leaves their network broken if the proxy dies. This library
// removes that: it is injected into one app at launch (SIMCTL_CHILD_DYLD_INSERT_LIBRARIES) and sets the
// proxy on that process's own URL sessions. Nothing outside the app is touched, so there is nothing to
// restore and nothing to leak if we crash.
//
// The mechanism is `NSURLSessionConfiguration.connectionProxyDictionary`. Every session the app builds
// comes from one of a handful of factory methods, so those are swizzled to stamp the proxy on the way
// out. Traffic that does not go through NSURLSession (a raw socket, a bundled network stack) is not
// covered, and neither is a session built before this library loads.

#import <Foundation/Foundation.h>
#import <objc/runtime.h>
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
        const char *port = getenv("SIMNET_PROXY_PORT");
        if (port == NULL || atol(port) <= 0) {
            // Nothing to do: the app was launched without capture enabled.
            return;
        }
        long candidate = atol(port);
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
