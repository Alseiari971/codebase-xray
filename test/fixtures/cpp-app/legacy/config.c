typedef struct {
  int width;
} Config;

static int clamp(int v) { return v < 0 ? 0 : v; }

int config_width(Config* c) {
  return clamp(c->width);
}
