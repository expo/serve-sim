#import "CoreDeviceShim.h"
#import <Foundation/Foundation.h>
#import <dlfcn.h>

struct MetadataResponse { void *metadata; uintptr_t state; };
typedef struct MetadataResponse (*Metadata)(uintptr_t) __attribute__((swiftcall));
typedef struct MetadataResponse (*OptionalMetadata)(uintptr_t, void *) __attribute__((swiftcall));
typedef void (*InitKey)(void * __attribute__((swift_indirect_result)), uint16_t) __attribute__((swiftcall));
typedef void (*InitState)(void * __attribute__((swift_indirect_result)), uint8_t) __attribute__((swiftcall));
typedef void (*SendKey)(void *, void *, void *, void *, void * __attribute__((swift_context)), void ** __attribute__((swift_error_result))) __attribute__((swiftcall));
typedef void (*Barrier)(void *, void *, void * __attribute__((swift_context))) __attribute__((swiftcall));
typedef void (*ReleaseError)(void *);

static void *keyMetadata, *optionalStateMetadata;
static InitKey initKey;
static InitState initState;
static SendKey sendKey;
static Barrier barrier;
static ReleaseError releaseError;

bool SSCoreDeviceKeyboardAvailable(void) {
    static dispatch_once_t once;
    static bool available;
    dispatch_once(&once, ^{
        if (!SSCoreDeviceInitialize()) return;
        bool found = true;
        Metadata keyType, stateType;
#define RESOLVE(variable, symbol) do { variable = (typeof(variable))SSCoreDeviceSymbol(symbol); found &= variable != NULL; } while (0)
        RESOLVE(keyType, "$s10CoreDevice20HIDKeyboardUsageCodeVMa");
        RESOLVE(stateType, "$s10CoreDevice14HIDButtonStateOMa");
        RESOLVE(initKey, "$s10CoreDevice20HIDKeyboardUsageCodeV8rawValueACs6UInt16V_tcfC");
        RESOLVE(initState, "$s10CoreDevice14HIDButtonStateO8rawValueACSgs5UInt8V_tcfC");
        RESOLVE(sendKey, "$s10CoreDevice11HIDKeyboardP4send3key5stateyAA0C9UsageCodeV_AA14HIDButtonStateOtKFTj");
        RESOLVE(barrier, "$s10CoreDevice11HIDKeyboardP11sendBarrieryyFTj");
#undef RESOLVE
        OptionalMetadata optionalType = (OptionalMetadata)dlsym(RTLD_DEFAULT, "$sSqMa");
        releaseError = (ReleaseError)dlsym(RTLD_DEFAULT, "swift_errorRelease");
        if (!found || !optionalType || !releaseError) return;
        keyMetadata = keyType(0).metadata;
        void *stateMetadata = stateType(0).metadata;
        if (!keyMetadata || !stateMetadata) return;
        optionalStateMetadata = optionalType(0, stateMetadata).metadata;
        // rawValue initializers construct Apple's resilient values. The state
        // initializer returns Optional, which may need an additional tag byte.
        available = optionalStateMetadata &&
            SSCoreDeviceValueSize(keyMetadata) == sizeof(uint16_t) &&
            SSCoreDeviceValueSize(stateMetadata) == sizeof(uint8_t) &&
            SSCoreDeviceValueSize(optionalStateMetadata) >= sizeof(uint8_t) &&
            SSCoreDeviceValueSize(optionalStateMetadata) <= 2;
    });
    return available;
}

bool SSCoreDeviceSendKey(void *capability, uint32_t usage, bool down) {
    if (!capability || usage > UINT16_MAX || !SSCoreDeviceKeyboardAvailable()) return false;
    void *metadata = ((void **)capability)[3], *witness = ((void **)capability)[4];
    if (!metadata || !witness) return false;

    uint16_t key = 0;
    uint8_t state[2] = {0};
    initKey(&key, (uint16_t)usage);
    initState(state, down ? 1 : 2);
    void *error = NULL;
    sendKey(&key, state, metadata, witness, capability, &error);
    SSCoreDeviceDestroyValue(&key, keyMetadata);
    SSCoreDeviceDestroyValue(state, optionalStateMetadata);
    // HIDKeyboard uses untyped Swift throws, unlike UniversalHID's typed
    // CoreDeviceError result. The error register owns a Swift error object.
    if (error) {
        releaseError(error);
        return false;
    }
    barrier(metadata, witness, capability);
    return true;
}
