#pragma once

#include <array>
#include <cstdint>
#include <functional>

using Color = std::array<uint8_t, 3>;
namespace std {
    template <> struct hash<Color> {
        size_t operator()(const Color& s) const noexcept {
            uint32_t h = (static_cast<uint32_t>(s[0]) << 16) | (static_cast<uint32_t>(s[1]) << 8) | (static_cast<uint32_t>(s[2]));
            return static_cast<size_t>(h);
        }
    };
}
