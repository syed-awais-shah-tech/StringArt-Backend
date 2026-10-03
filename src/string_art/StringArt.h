#pragma once

#include <memory>
#include <random>
#include <utility>
#include <vector>

#include "src/compute/OpenCLManager.h"
#include "src/geometry/Point2.h"
#include "src/image/Image.h"

class StringArtGenerator {
public:
    StringArtGenerator(const Image& input, std::pair<int, int> imageSize, size_t nailsCount, size_t maxConnections,
                       std::span<const Color> threadColors, std::mt19937& gen);

    void generate(const float alpha, const float kDensity);

    Image getResultImage();
    const std::vector<std::pair<Color, uint32_t>>& getSequence() const;

    std::vector<std::pair<Color, uint32_t>> loadSequence(std::string_view filename);
    const Image& rebuildFromSequence(std::span<const std::pair<Color, uint32_t>> sequences, float alpha);

private:
    void initializeNails(size_t nailsCount, short w, short h);

    Image targetImage;
    Image currentImage;
    std::vector<std::pair<Color, uint32_t>> sequence;
    std::vector<uint16_t> density;
    std::vector<Point2s> nails;
    std::vector<Thread> threads;
    size_t maxIter;
    std::unique_ptr<OpenCLManager> ocl;
};
