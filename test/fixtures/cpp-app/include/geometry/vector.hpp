#pragma once

namespace geo {

struct Vec2 {
  float x, y;
  float length() const;
  Vec2 scaled(float k) const { return Vec2{x * k, y * k}; }
};

float dot(const Vec2& a, const Vec2& b);

}  // namespace geo
