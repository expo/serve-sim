// Inserted into every simulator process via launchd DYLD_INSERT_LIBRARIES, so
// it links libSystem only: a Foundation-linked insert crash-loops GSSCred, and
// loading UIKit from the constructor crashes Safari on headless boots. All the
// real work happens in capability dylibs this one dlopens off a detached thread.
//
// Config format, one capability per line, written by the launch manager:
//   <container>\t<dylib>\t[KEY=VALUE;KEY=VALUE]
//
// The launch manager sets SERVE_SIM_CAPABILITIES_CONFIG alongside the insert,
// per simulator, so the config can live with the rest of serve-sim's state
// rather than inside the installed package.

#include <dispatch/dispatch.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <mach-o/dyld.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define CONFIG_VAR "SERVE_SIM_CAPABILITIES_CONFIG"
#define MAX_CONFIG_BYTES (64 * 1024)
// A capability that links UIKit asks to be loaded late; one that links only
// libSystem does not have to wait for it.
#define MAX_LOAD_DELAY_MS 10000
#define MAX_CAPABILITIES 64

// 0 read the whole file, 1 the file did not fit, -1 could not read it.
static int read_config(const char *path, char *out, size_t cap) {
  int fd;
  do {
    fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW);
  } while (fd < 0 && errno == EINTR);
  if (fd < 0) return -1;

  // Only a real file. A fifo or device would give this thread a read that never ends.
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

// An app the user installed lives under the device's own Bundle container; an
// Apple app ships inside the runtime, under RuntimeRoot.
#define USER_APP_MARKER "/Containers/Bundle/Application/"

// Splits one config line and answers whether it applies to this app. Returns 1
// and points dylib/env into the line, or 0 to skip it. Separate from the load
// loop so it can be tested without dlopen.
static unsigned parse_delay_ms(const char *text) {
  if (text == NULL || *text == '\0') return 0;
  char *end = NULL;
  errno = 0;
  long value = strtol(text, &end, 10);
  if (errno != 0 || end == text || *end != '\0' || value < 0) return 0;
  if (value > MAX_LOAD_DELAY_MS) return MAX_LOAD_DELAY_MS;
  return (unsigned)value;
}

static int capability_applies(char *line, const char *exec_path, char **dylib_out,
                             char **env_out, unsigned *delay_ms_out) {
  if (*line == '\0' || *line == '#') return 0;

  char *fields = line;
  char *scope = strsep(&fields, "\t");
  char *dylib = strsep(&fields, "\t");
  char *env = strsep(&fields, "\t");
  char *delay = strsep(&fields, "\t");
  if (dylib == NULL || *dylib == '\0') return 0;
  if (*dylib != '/') {
    fprintf(stderr, "[serve-sim] ignoring capability path that is not absolute: %s\n", dylib);
    return 0;
  }

  // `all` needs no check of its own: the constructor already refused anything
  // that is not an app. An unknown scope loads nowhere.
  if (strcmp(scope, "user") == 0) {
    if (strstr(exec_path, USER_APP_MARKER) == NULL) return 0;
  } else if (strcmp(scope, "all") != 0) {
    fprintf(stderr, "[serve-sim] ignoring capability with unknown scope '%s': %s\n", scope, dylib);
    return 0;
  }

  *dylib_out = dylib;
  *env_out = env;
  *delay_ms_out = parse_delay_ms(delay);
  return 1;
}

struct Load {
  char exec_path[1024];
  char config_path[1024];
};

struct Pending {
  unsigned delay_ms;
  char *dylib;
  char *env;
};

static void load_capabilities(struct Load *load) {
  const char *exec_path = load->exec_path;
  const char *config_path = load->config_path;

  char *config = malloc(MAX_CONFIG_BYTES);
  if (config == NULL) return;
  int status = read_config(config_path, config, MAX_CONFIG_BYTES);
  if (status != 0) {
    if (status > 0) {
      fprintf(stderr, "[serve-sim] %s exceeds %d bytes; no capabilities loaded.\n",
              config_path, MAX_CONFIG_BYTES);
    }
    free(config);
    return;
  }

  struct Pending pending[MAX_CAPABILITIES];
  size_t count = 0;
  char *line, *lines = config;
  while ((line = strsep(&lines, "\n")) != NULL) {
    char *dylib, *env;
    unsigned delay_ms;
    if (!capability_applies(line, exec_path, &dylib, &env, &delay_ms)) continue;
    if (count == MAX_CAPABILITIES) {
      fprintf(stderr, "[serve-sim] more than %d capabilities apply; ignoring the rest.\n",
              MAX_CAPABILITIES);
      break;
    }
    pending[count].delay_ms = delay_ms;
    pending[count].dylib = dylib;
    pending[count].env = env;
    count++;
  }

  // Soonest first, so one capability's delay never holds up another's.
  for (size_t i = 1; i < count; i++) {
    struct Pending key = pending[i];
    size_t j = i;
    while (j > 0 && pending[j - 1].delay_ms > key.delay_ms) {
      pending[j] = pending[j - 1];
      j--;
    }
    pending[j] = key;
  }

  unsigned slept_ms = 0;
  for (size_t i = 0; i < count; i++) {
    if (pending[i].delay_ms > slept_ms) {
      usleep((useconds_t)(pending[i].delay_ms - slept_ms) * 1000);
      slept_ms = pending[i].delay_ms;
    }
    if (pending[i].env != NULL && apply_env(pending[i].env) != 0) {
      fprintf(stderr, "[serve-sim] not loading %s: its environment is incomplete\n",
              pending[i].dylib);
      continue;
    }
    if (dlopen(pending[i].dylib, RTLD_NOW | RTLD_LOCAL) == NULL) {
      fprintf(stderr, "[serve-sim] could not load %s: %s\n", pending[i].dylib, dlerror());
    }
  }
  free(config);
}

static int config_dir(const char *path, char *out, size_t cap) {
  int n = snprintf(out, cap, "%s", path);
  if (n < 0 || (size_t)n >= cap) return -1;
  char *slash = strrchr(out, '/');
  if (slash == NULL || slash == out) return -1;
  *slash = '\0';
  return 0;
}

// A capability turned on while the app is already running has to reach it, or
// the only way to pick one up is to start the app again. dlopen of something
// already loaded is a no-op, so re-reading the whole config is safe. The
// directory is watched rather than the file because the writer replaces it by
// rename, which a file watch would stop following.
static void watch_config(struct Load *load) {
  char dir[sizeof load->config_path];
  if (config_dir(load->config_path, dir, sizeof dir) != 0) return;

  int fd = open(dir, O_EVTONLY);
  if (fd < 0) return;

  dispatch_source_t source = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_VNODE, (uintptr_t)fd, DISPATCH_VNODE_WRITE, dispatch_get_main_queue());
  if (source == NULL) {
    close(fd);
    return;
  }
  dispatch_source_set_event_handler(source, ^{ load_capabilities(load); });
  dispatch_source_set_cancel_handler(source, ^{ close(fd); });
  dispatch_resume(source);
}

// getenv and access are safe in a constructor; the dlopen is not.
__attribute__((constructor))
static void serve_sim_trampoline_init(void) {
  const char *tmp = getenv("TMPDIR");
  if (tmp == NULL || strstr(tmp, "/Containers/Data/Application/") == NULL) return;

  // Absolute only. A relative path would resolve against the app's working
  // directory, which is not ours to guess.
  const char *config = getenv(CONFIG_VAR);
  if (config == NULL || *config != '/') return;

  struct Load *load = malloc(sizeof *load);
  if (load == NULL) return;
  char dir[sizeof load->config_path];

  int n = snprintf(load->config_path, sizeof load->config_path, "%s", config);
  if (n < 0 || (size_t)n >= sizeof load->config_path) {
    free(load);
    return;
  }
  // The file need not exist yet: a capability turned on later creates it, and
  // the watch is on the directory. Requiring the file here would mean an app
  // started before the first capability could never receive one.
  if (config_dir(load->config_path, dir, sizeof dir) != 0 || access(dir, R_OK | X_OK) != 0) {
    free(load);
    return;
  }
  uint32_t exec_size = sizeof load->exec_path;
  if (_NSGetExecutablePath(load->exec_path, &exec_size) != 0) {
    free(load);
    return;
  }

  // Loading anything here, or from a thread racing this one, deadlocks: the
  // app's launch holds the ObjC load lock and wants dyld's, while a concurrent
  // dlopen holds dyld's and wants ObjC's. FrontBoard then kills the app for
  // taking too long to launch. The main queue does not run until the app is
  // past that, so it is the signal that loading is safe. A process that never
  // runs its main queue loads nothing, which is the right answer for one that
  // is not an app.
  // On the main queue itself, not hopping off it: the block is queued before
  // the app's own, so the capability is in place before the app can ask for it.
  dispatch_async(dispatch_get_main_queue(), ^{
    load_capabilities(load);
    watch_config(load);
  });
}
