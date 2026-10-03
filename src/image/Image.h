#pragma once

#include <cstdint>
#include <string_view>

class Image {
public:
    Image();

    Image(int w, int h, uint8_t c);

    Image(const Image& other);

    Image(Image&& other) noexcept;

    Image& operator=(const Image& other);

    Image& operator=(Image&& other) noexcept;

    ~Image();

    void clear();

    void load(std::string_view filename);

    void save(std::string_view filename) const;

    void resize(int new_width, int new_height);

    const uint8_t* data() const noexcept;
    uint8_t* data() noexcept;

    int width() const noexcept;

    int height() const noexcept;

    uint8_t channels() const noexcept;

    uint8_t* operator()(int x, int y) noexcept;
    const uint8_t* operator()(int x, int y) const noexcept;

    uint8_t* operator[](int index) noexcept;
    const uint8_t* operator[](int index) const noexcept;

private:
    int width_, height_;
    uint8_t channels_;
    uint8_t* data_ = nullptr;
};
