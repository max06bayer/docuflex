#define _POSIX_C_SOURCE 200809L

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int set_default_environment(const char *name, const char *value) {
  if (getenv(name) != NULL) {
    return 0;
  }
  return setenv(name, value, 1);
}

static void write_test_marker(void) {
  const char *marker = getenv("DOCUFLEX_LAUNCHER_MARKER");
  if (marker == NULL || marker[0] == '\0') {
    return;
  }

  FILE *output = fopen(marker, "w");
  if (output == NULL) {
    return;
  }
  fprintf(output, "dmabuf=%s\ncompositing=%s\n",
          getenv("WEBKIT_DISABLE_DMABUF_RENDERER"),
          getenv("WEBKIT_DISABLE_COMPOSITING_MODE"));
  fclose(output);
}

int main(int argc, char **argv) {
  if (set_default_environment("WEBKIT_DISABLE_DMABUF_RENDERER", "1") != 0 ||
      set_default_environment("WEBKIT_DISABLE_COMPOSITING_MODE", "1") != 0) {
    fprintf(stderr, "Docuflex launcher could not configure WebKit: %s\n",
            strerror(errno));
    return 126;
  }

  write_test_marker();

  char **child_arguments = calloc((size_t)argc + 1, sizeof(char *));
  if (child_arguments == NULL) {
    fprintf(stderr, "Docuflex launcher could not allocate arguments.\n");
    return 126;
  }
  child_arguments[0] = (char *)"docuflex-desktop";
  for (int index = 1; index < argc; index++) {
    child_arguments[index] = argv[index];
  }

  execvp(child_arguments[0], child_arguments);
  fprintf(stderr, "Docuflex launcher could not start the application: %s\n",
          strerror(errno));
  free(child_arguments);
  return 127;
}
