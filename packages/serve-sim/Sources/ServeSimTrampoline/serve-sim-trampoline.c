// Inserted into every simulator process via launchd DYLD_INSERT_LIBRARIES, so
// it links libSystem only: a Foundation-linked insert crash-loops GSSCred, and
// loading UIKit from the constructor crashes Safari on headless boots. All the
// real work happens in capability dylibs this one dlopens off a detached thread.
//
// Config format, one capability per line, written by the launch manager:
//   <container>\t<dylib>\t[KEY=VALUE;KEY=VALUE]
//
// One config per simulator, named capabilities-<UDID>.conf beside this dylib.
// The UDID comes from TMPDIR, which sits under .../Devices/<UDID>/data/.

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define CONFIG_PREFIX "capabilities-"
#define MAX_CONFIG_BYTES (64 * 1024)
#define LOAD_DELAY_US (500 * 1000)

// 0 read the whole file, 1 the file did not fit, -1 could not read it.
static int read_config(const char *path, char *out, size_t cap) {
  int fd;
  do {
    fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
  } while (fd < 0 && errno == EINTR);
  if (fd < 0) return -1;

  // Only a real file. A fifo here would block this thread for the life of the app.
  struct stat info;
  if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode)) {
    close(fd);
    return -1;
  }

  size_t used = 0;
  int truncated = 0;
  for (;;) {
    ssize_t n = read(fd, out + used, cap - 1 - used);
    if (n < 0) {
      if (errno == EINTR) continue;
      close(fd);
      return -1;
    }
    if (n == 0) break;
    used += (size_t)n;
    if (used >= cap - 1) { truncated = 1; break; }
  }
  close(fd);
  out[used] = '\0';
  return truncated;
}

static int apply_env(char *pairs) {
  int failed = 0;
  char *pair, *rest = pairs;
  while ((pair = strsep(&rest, ";")) != NULL) {
    if (*pair == '\0') continue;
    char *eq = strchr(pair, '=');
    if (eq == NULL) continue;
    *eq = '\0';
    if (setenv(pair, eq + 1, 1) != 0) {
      fprintf(stderr, "[serve-sim] could not set %s for a capability\n", pair);
      failed = 1;
    }
  }
  return failed;
}

// Splits one config line and answers whether it applies to this app. Returns 1
// and points dylib/env into the line, or 0 to skip it. Separate from the load
// loop so it can be tested without dlopen.
static int capability_applies(char *line, const char *tmpdir, char **dylib_out, char **env_out) {
  if (*line == '\0' || *line == '#') return 0;

  char *fields = line;
  char *container = strsep(&fields, "\t");
  char *dylib = strsep(&fields, "\t");
  char *env = strsep(&fields, "\t");
  if (container == NULL || dylib == NULL || *dylib == '\0') return 0;
  if (*dylib != '/') {
    fprintf(stderr, "[serve-sim] ignoring capability path that is not absolute: %s\n", dylib);
    return 0;
  }

  // Empty matches every app. Otherwise the container must be TMPDIR or one of
  // its ancestors; the writer only ever emits the app's own container path.
  size_t clen = strlen(container);
  if (clen > 0) {
    if (strncmp(tmpdir, container, clen) != 0) return 0;
    if (tmpdir[clen] != '/' && tmpdir[clen] != '\0') return 0;
  }

  *dylib_out = dylib;
  *env_out = env;
  return 1;
}

struct Load {
  char tmpdir[1024];
  char config_path[1024];
};

static void *load_capabilities(void *arg) {
  struct Load *load = arg;
  const char *tmpdir = load->tmpdir;
  const char *config_path = load->config_path;
  usleep(LOAD_DELAY_US);

  char *config = malloc(MAX_CONFIG_BYTES);
  if (config == NULL) goto done;
  int status = read_config(config_path, config, MAX_CONFIG_BYTES);
  if (status != 0) {
    if (status > 0) {
      fprintf(stderr, "[serve-sim] %s exceeds %d bytes; no capabilities loaded.\n",
              config_path, MAX_CONFIG_BYTES);
    }
    free(config);
    goto done;
  }

  char *line, *lines = config;
  while ((line = strsep(&lines, "\n")) != NULL) {
    char *dylib, *env;
    if (!capability_applies(line, tmpdir, &dylib, &env)) continue;
    if (env != NULL && apply_env(env) != 0) {
      fprintf(stderr, "[serve-sim] not loading %s: its environment is incomplete\n", dylib);
      continue;
    }
    if (dlopen(dylib, RTLD_NOW | RTLD_LOCAL) == NULL) {
      fprintf(stderr, "[serve-sim] could not load %s: %s\n", dylib, dlerror());
    }
  }
  free(config);

done:
  free(load);
  return NULL;
}

// Copies the simulator UDID out of an app's TMPDIR. Returns 0 when the path is
// not shaped like a simulator container, so an unrecognised layout loads nothing
// rather than reading another device's config.
static int device_udid(const char *tmpdir, char *out, size_t cap) {
  const char *marker = strstr(tmpdir, "/Devices/");
  if (marker == NULL) return 0;
  const char *start = marker + strlen("/Devices/");
  const char *end = strchr(start, '/');
  if (end == NULL || end == start) return 0;
  size_t len = (size_t)(end - start);
  if (len >= cap) return 0;
  memcpy(out, start, len);
  out[len] = '\0';
  return 1;
}

// dladdr and access are safe in a constructor; the dlopen is not.
__attribute__((constructor))
static void serve_sim_trampoline_init(void) {
  const char *tmp = getenv("TMPDIR");
  if (tmp == NULL || strstr(tmp, "/Containers/Data/Application/") == NULL) return;

  Dl_info info;
  if (dladdr((void *)serve_sim_trampoline_init, &info) == 0 || info.dli_fname == NULL) return;
  const char *slash = strrchr(info.dli_fname, '/');
  if (slash == NULL) return;

  char udid[128];
  if (device_udid(tmp, udid, sizeof udid) == 0) return;

  struct Load *load = malloc(sizeof *load);
  if (load == NULL) return;

  int n = snprintf(load->config_path, sizeof load->config_path, "%.*s/" CONFIG_PREFIX "%s.conf",
                   (int)(slash - info.dli_fname), info.dli_fname, udid);
  if (n < 0 || (size_t)n >= sizeof load->config_path || access(load->config_path, R_OK) != 0) {
    free(load);
    return;
  }
  n = snprintf(load->tmpdir, sizeof load->tmpdir, "%s", tmp);
  if (n < 0 || (size_t)n >= sizeof load->tmpdir) {
    free(load);
    return;
  }

  pthread_t thread;
  if (pthread_create(&thread, NULL, load_capabilities, load) != 0) {
    free(load);
    return;
  }
  pthread_detach(thread);
}
