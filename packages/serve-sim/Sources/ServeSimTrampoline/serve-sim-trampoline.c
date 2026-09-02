// Inserted into every simulator process via launchd DYLD_INSERT_LIBRARIES, so
// it links libSystem only: a Foundation-linked insert crash-loops GSSCred, and
// loading UIKit from the constructor crashes Safari on headless boots. All the
// real work happens in capability dylibs this one dlopens off a detached thread.
//
// Config format, one capability per line, written by the launch manager:
//   <container>\t<dylib>\t[KEY=VALUE;KEY=VALUE]

#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define CONFIG_NAME "capabilities.conf"
#define MAX_CONFIG_BYTES (64 * 1024)
#define LOAD_DELAY_US (500 * 1000)

// 0 read the whole file, 1 the file did not fit, -1 could not read it.
static int read_config(const char *path, char *out, size_t cap) {
  int fd;
  do {
    fd = open(path, O_RDONLY);
  } while (fd < 0 && errno == EINTR);
  if (fd < 0) return -1;

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
    if (*line == '\0' || *line == '#') continue;
    char *fields = line;
    char *container = strsep(&fields, "\t");
    char *dylib = strsep(&fields, "\t");
    char *env = strsep(&fields, "\t");
    if (container == NULL || dylib == NULL || *dylib == '\0') continue;
    if (*dylib != '/') {
      fprintf(stderr, "[serve-sim] ignoring capability path that is not absolute: %s\n", dylib);
      continue;
    }
    // An empty container matches every app.
    size_t clen = strlen(container);
    if (clen > 0) {
      if (strncmp(tmpdir, container, clen) != 0) continue;
      if (tmpdir[clen] != '/' && tmpdir[clen] != '\0') continue;
    }
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

// dladdr and access are safe in a constructor; the dlopen is not.
__attribute__((constructor))
static void serve_sim_trampoline_init(void) {
  const char *tmp = getenv("TMPDIR");
  if (tmp == NULL || strstr(tmp, "/Containers/Data/Application/") == NULL) return;

  Dl_info info;
  if (dladdr((void *)serve_sim_trampoline_init, &info) == 0 || info.dli_fname == NULL) return;
  const char *slash = strrchr(info.dli_fname, '/');
  if (slash == NULL) return;

  struct Load *load = malloc(sizeof *load);
  if (load == NULL) return;

  int n = snprintf(load->config_path, sizeof load->config_path, "%.*s/" CONFIG_NAME,
                   (int)(slash - info.dli_fname), info.dli_fname);
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
