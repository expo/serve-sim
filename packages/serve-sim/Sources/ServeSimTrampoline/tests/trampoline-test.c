// Host-compiled tests for the trampoline's parsing. Includes the dylib source
// so the static helpers are reachable; the constructor is a no-op here because
// TMPDIR is not an app container.

#include "../serve-sim-trampoline.c"

#include <sys/stat.h>

static int failures = 0;

#define CHECK(cond, what)                                                       \
  do {                                                                          \
    if (!(cond)) {                                                              \
      fprintf(stdout, "FAIL %s (%s:%d)\n", (what), __FILE__, __LINE__);         \
      failures++;                                                               \
    }                                                                           \
  } while (0)

#define MAX_TEMPS 8
static char temps[MAX_TEMPS][1024];
static int temp_count = 0;

static char *write_temp(const char *name, const char *contents, size_t len) {
  if (temp_count >= MAX_TEMPS) abort();
  char *path = temps[temp_count++];
  snprintf(path, sizeof temps[0], "/tmp/serve-sim-trampoline-test-%d-%s", getpid(), name);
  FILE *file = fopen(path, "w");
  if (file == NULL) abort();
  size_t written = fwrite(contents, 1, len, file);
  if (written != len || fclose(file) != 0) abort();
  return path;
}

static void remove_temps(void) {
  for (int i = 0; i < temp_count; i++) unlink(temps[i]);
}

static void test_read_config(void) {
  char out[64];

  CHECK(read_config("/tmp/serve-sim-does-not-exist", out, sizeof out) == -1,
        "a missing config reports failure, not an empty config");

  const char *body = "a\tb\n";
  CHECK(read_config(write_temp("small", body, strlen(body)), out, sizeof out) == 0,
        "a config that fits reads whole");
  CHECK(strcmp(out, body) == 0, "the contents survive the read");

  char big[128];
  memset(big, 'x', sizeof big);
  CHECK(read_config(write_temp("big", big, sizeof big), out, sizeof out) == 1,
        "a config over the cap reports truncation rather than loading a prefix");

  CHECK(read_config(write_temp("empty", "", 0), out, sizeof out) == 0,
        "an empty config is readable");
  CHECK(out[0] == '\0', "an empty config yields an empty string");
}

static int applies(char *line, const char *tmpdir, char **dylib, char **env) {
  return capability_applies(line, tmpdir, dylib, env);
}

static void test_capability_applies(void) {
  const char *tmpdir = "/data/Containers/Data/Application/ABC/tmp";
  char *dylib = NULL;
  char *env = NULL;

  char match[] = "/data/Containers/Data/Application/ABC\t/opt/probe.dylib\tK=V";
  CHECK(applies(match, tmpdir, &dylib, &env) == 1, "a container prefix of this app matches");
  CHECK(strcmp(dylib, "/opt/probe.dylib") == 0, "the dylib field is returned");
  CHECK(strcmp(env, "K=V") == 0, "the environment field is returned");

  char wildcard[] = "\t/opt/probe.dylib\t";
  CHECK(applies(wildcard, tmpdir, &dylib, &env) == 1, "an empty container matches every app");

  char other[] = "/data/Containers/Data/Application/XYZ\t/opt/probe.dylib\t";
  CHECK(applies(other, tmpdir, &dylib, &env) == 0, "another app's container does not match");

  // Guards against a container that is a string prefix but a different directory.
  char sibling[] = "/data/Containers/Data/Application/ABCD\t/opt/probe.dylib\t";
  CHECK(applies(sibling, tmpdir, &dylib, &env) == 0,
        "a longer sibling container is not treated as this app");
  char shorter[] = "/data/Containers/Data/Application/AB\t/opt/probe.dylib\t";
  CHECK(applies(shorter, tmpdir, &dylib, &env) == 0,
        "a shorter prefix of this container does not match");

  char relative[] = "\topt/probe.dylib\t";
  CHECK(applies(relative, tmpdir, &dylib, &env) == 0, "a relative dylib path is refused");

  char empty[] = "";
  CHECK(applies(empty, tmpdir, &dylib, &env) == 0, "a blank line is skipped");
  char comment[] = "# a note";
  CHECK(applies(comment, tmpdir, &dylib, &env) == 0, "a comment is skipped");
  char no_dylib[] = "\t\t";
  CHECK(applies(no_dylib, tmpdir, &dylib, &env) == 0, "a line with no dylib is skipped");
  char truncated[] = "/data/Containers/Data/Application/ABC";
  CHECK(applies(truncated, tmpdir, &dylib, &env) == 0, "a line with no fields after the container is skipped");

  char no_env[] = "\t/opt/probe.dylib";
  CHECK(applies(no_env, tmpdir, &dylib, &env) == 1, "the environment field is optional");
  CHECK(env == NULL, "a missing environment field is reported as absent");
}

static void test_apply_env(void) {
  char pairs[] = "SERVE_SIM_TEST_A=1;SERVE_SIM_TEST_B=two";
  CHECK(apply_env(pairs) == 0, "well-formed pairs are applied");
  CHECK(getenv("SERVE_SIM_TEST_A") != NULL && strcmp(getenv("SERVE_SIM_TEST_A"), "1") == 0,
        "the first pair reaches the environment");
  CHECK(getenv("SERVE_SIM_TEST_B") != NULL && strcmp(getenv("SERVE_SIM_TEST_B"), "two") == 0,
        "the last pair reaches the environment");

  char messy[] = ";;SERVE_SIM_TEST_C=3;no-equals-sign;";
  CHECK(apply_env(messy) == 0, "empty and malformed pairs are skipped, not fatal");
  CHECK(getenv("SERVE_SIM_TEST_C") != NULL, "a good pair after a malformed one still applies");
  CHECK(getenv("no-equals-sign") == NULL, "a pair with no '=' sets nothing");

  char with_equals[] = "SERVE_SIM_TEST_D=a=b";
  CHECK(apply_env(with_equals) == 0, "a value containing '=' is allowed");
  CHECK(getenv("SERVE_SIM_TEST_D") != NULL && strcmp(getenv("SERVE_SIM_TEST_D"), "a=b") == 0,
        "only the first '=' separates the name from the value");

  // setenv rejects an empty name, which must be reported rather than swallowed.
  char bad_name[] = "=novalue";
  CHECK(apply_env(bad_name) != 0, "a pair setenv refuses is reported as a failure");
}

// Runs the load loop against a config, and returns what it wrote to stderr.
// load_capabilities frees its argument and only skips the dlopen for lines it
// rejects, so this exercises every branch the constructor would reach.
static char *load_and_capture(const char *config_body) {
  static char captured[4096];
  char log_path[1024];
  snprintf(log_path, sizeof log_path, "/tmp/serve-sim-trampoline-test-%d-stderr", getpid());

  char *config_path = write_temp("load-config", config_body, strlen(config_body));
  struct Load *load = malloc(sizeof *load);
  if (load == NULL) abort();
  snprintf(load->tmpdir, sizeof load->tmpdir, "%s",
           "/data/Containers/Data/Application/ABC/tmp");
  snprintf(load->config_path, sizeof load->config_path, "%s", config_path);

  fflush(stderr);
  int saved = dup(STDERR_FILENO);
  if (saved < 0) abort();
  int sink = open(log_path, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (sink < 0) abort();
  if (dup2(sink, STDERR_FILENO) < 0) abort();
  close(sink);

  load_capabilities(load);

  fflush(stderr);
  if (dup2(saved, STDERR_FILENO) < 0) abort();
  close(saved);

  FILE *file = fopen(log_path, "r");
  if (file == NULL) abort();
  size_t n = fread(captured, 1, sizeof captured - 1, file);
  captured[n] = '\0';
  fclose(file);
  unlink(log_path);
  return captured;
}

// The writer never emits an ancestor, but the prefix rule accepts one, so pin
// the behaviour rather than leave it to be discovered.
static void test_ancestor_containers(void) {
  const char *tmpdir = "/data/Containers/Data/Application/ABC/tmp";
  char *dylib = NULL;
  char *env = NULL;

  char ancestor[] = "/data/Containers/Data/Application\t/opt/probe.dylib\t";
  CHECK(capability_applies(ancestor, tmpdir, &dylib, &env) == 1,
        "an ancestor of the container matches, which only the writer prevents");

  char root[] = "/\t/opt/probe.dylib\t";
  CHECK(capability_applies(root, tmpdir, &dylib, &env) == 0,
        "a lone slash does not match, because the next character is not a separator");
}

static void test_device_udid(void) {
  char udid[128];

  const char *real =
      "/Users/x/Library/Developer/CoreSimulator/Devices/ABC-123/data/Containers/Data/"
      "Application/DEF/tmp";
  CHECK(device_udid(real, udid, sizeof udid) == 1, "a simulator container yields a udid");
  CHECK(strcmp(udid, "ABC-123") == 0, "the udid is the path component after /Devices/");

  CHECK(device_udid("/tmp/nothing/like/it", udid, sizeof udid) == 0,
        "a path with no /Devices/ yields nothing, so no config is read");
  CHECK(device_udid("/a/Devices/", udid, sizeof udid) == 0,
        "a trailing /Devices/ with no component yields nothing");
  CHECK(device_udid("/a/Devices//data", udid, sizeof udid) == 0,
        "an empty udid component yields nothing");

  char tiny[4];
  CHECK(device_udid(real, tiny, sizeof tiny) == 0,
        "a udid longer than the buffer yields nothing rather than truncating");
}

static void test_load_capabilities(void) {
  char *out = load_and_capture("\t/opt/serve-sim-missing.dylib\t\n");
  CHECK(strstr(out, "could not load /opt/serve-sim-missing.dylib") != NULL,
        "a dylib that will not load is reported, not silently skipped");

  out = load_and_capture("\t/opt/serve-sim-missing.dylib\t=novalue\n");
  CHECK(strstr(out, "not loading /opt/serve-sim-missing.dylib") != NULL,
        "an environment that cannot be applied blocks the load");
  CHECK(strstr(out, "could not load") == NULL,
        "a blocked load is not attempted anyway");

  out = load_and_capture("/data/Containers/Data/Application/XYZ\t/opt/other.dylib\t\n");
  CHECK(out[0] == '\0', "another app's capability produces no output and no load");

  char loaded_marker[1024];
  snprintf(loaded_marker, sizeof loaded_marker, "/tmp/serve-sim-host-probe-%d.txt", getpid());
  unlink(loaded_marker);
  char line[4096];
  snprintf(line, sizeof line, "\t%s\tSERVE_SIM_HOST_PROBE_FILE=%s\n",
           SERVE_SIM_TEST_DYLIB, loaded_marker);
  out = load_and_capture(line);
  CHECK(out[0] == '\0', "a capability that loads reports nothing");
  FILE *marker = fopen(loaded_marker, "r");
  CHECK(marker != NULL, "the capability dylib was dlopened");
  if (marker != NULL) fclose(marker);
  unlink(loaded_marker);

  char oversized[MAX_CONFIG_BYTES + 16];
  memset(oversized, 'x', sizeof oversized);
  oversized[sizeof oversized - 1] = '\0';
  out = load_and_capture(oversized);
  CHECK(strstr(out, "no capabilities loaded") != NULL,
        "a config over the limit loads nothing rather than a truncated prefix");
}

int main(void) {
  test_read_config();
  test_capability_applies();
  test_ancestor_containers();
  test_device_udid();
  test_apply_env();
  test_load_capabilities();
  remove_temps();
  if (failures == 0) fprintf(stdout, "ok\n");
  return failures == 0 ? 0 : 1;
}
