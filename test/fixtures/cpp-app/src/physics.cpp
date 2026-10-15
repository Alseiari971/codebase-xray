#include "physics.hpp"
#include <vector>
#include <fmt/core.h>
#include "missing.h"

void Body::step(float dt) {
  integrate(dt);
  this->integrate(dt);
  auto s = velocity.scaled(2.0f);
  geo::dot(s, s);
}

void Body::integrate(float dt) {
  velocity.length();
}

static void helper() {}
