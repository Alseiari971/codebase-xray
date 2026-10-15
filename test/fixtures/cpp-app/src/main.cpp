#include "physics.hpp"

int main() {
  Body* body = new Body();
  body->step(0.016f);
  return 0;
}
