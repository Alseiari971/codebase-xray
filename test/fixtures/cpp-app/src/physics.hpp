#pragma once
#include "../include/geometry/vector.hpp"

class Body {
 public:
  void step(float dt);

 private:
  geo::Vec2 velocity{1, 0};
  void integrate(float dt);
};
