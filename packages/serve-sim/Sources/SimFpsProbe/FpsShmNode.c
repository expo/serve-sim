#include <node_api.h>
#include <errno.h>
#include <stdbool.h>
#include <string.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include "SimFpsShared.h"

static int simfps_shm_copy(const char *name, void *out) {
    int fd = shm_open(name, O_RDWR, 0);
    if (fd < 0) return -1;
    struct stat info;
    if (fstat(fd, &info) != 0 || info.st_size < SIMFPS_SHM_SIZE) {
        close(fd);
        return -1;
    }
    void *map = mmap(NULL, SIMFPS_SHM_SIZE, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    close(fd);
    if (map == MAP_FAILED) return -1;

    uint8_t tmp[SIMFPS_SHM_SIZE];
    int ok = -1;
    for (int i = 0; i < 8; i++) {
        memcpy(tmp, map, SIMFPS_SHM_SIZE);
        const SimFpsShmHeader *hdr = (const SimFpsShmHeader *)tmp;
        if (hdr->magic != SIMFPS_SHM_MAGIC || hdr->version != SIMFPS_SHM_VERSION) break;
        if ((hdr->seq & 1u) == 0 && hdr->seq == hdr->seqCopy && hdr->seq != 0) {
            memcpy(out, tmp, SIMFPS_SHM_SIZE);
            ok = 0;
            break;
        }
    }
    munmap(map, SIMFPS_SHM_SIZE);
    return ok;
}

static napi_value Copy(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
    napi_value ud;
    napi_get_undefined(env, &ud);
    if (argc < 1) return ud;

    char name[32];
    size_t len = 0;
    if (napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &len) != napi_ok || len == 0) {
        return ud;
    }

    uint8_t buf[SIMFPS_SHM_SIZE];
    if (simfps_shm_copy(name, buf) != 0) return ud;

    void *data = NULL;
    napi_value ab;
    if (napi_create_arraybuffer(env, SIMFPS_SHM_SIZE, &data, &ab) != napi_ok || data == NULL) {
        return ud;
    }
    memcpy(data, buf, SIMFPS_SHM_SIZE);
    return ab;
}

static napi_value Remove(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value argv[1];
    napi_get_cb_info(env, info, &argc, argv, NULL, NULL);

    bool removed = false;
    if (argc >= 1) {
        char name[32];
        size_t len = 0;
        if (napi_get_value_string_utf8(env, argv[0], name, sizeof(name), &len) == napi_ok && len > 0) {
            removed = shm_unlink(name) == 0 || errno == ENOENT;
        }
    }

    napi_value result;
    napi_get_boolean(env, removed, &result);
    return result;
}

NAPI_MODULE_INIT() {
    napi_value copy;
    napi_create_function(env, "copy", NAPI_AUTO_LENGTH, Copy, NULL, &copy);
    napi_set_named_property(env, exports, "copy", copy);
    napi_value remove;
    napi_create_function(env, "remove", NAPI_AUTO_LENGTH, Remove, NULL, &remove);
    napi_set_named_property(env, exports, "remove", remove);
    return exports;
}
