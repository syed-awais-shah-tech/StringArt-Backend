#pragma once

template <typename T> struct Point2 {
    T x, y;
    Point2(T x = T{}, T y = T{}) : x(x), y(y) {}
};

using Point2s = Point2<short>;
