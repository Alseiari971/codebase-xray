#include "geometry/vector.hpp"
#include <cmath>

namespace geo {

float Vec2::length() const {
  return std::sqrt(dot(*this, *this));
}

float dot(const Vec2& a, const Vec2& b) {
  return a.x * b.x + a.y * b.y;
}

}  // namespace geo
