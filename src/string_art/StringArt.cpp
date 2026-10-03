#include "StringArt.h"

#include <cmath>
#include <fstream>
#include <iostream>
#include <numbers>

void StringArtGenerator::initializeNails(const size_t nailsCount, const short w, const short h) {
    const short radiusW = w / 2 - 1;
    const short radiusH = h / 2 - 1;
    const Point2s center(static_cast<short>(w / 2), static_cast<short>(h / 2));
    nails.reserve(nailsCount);
    for (size_t i = 0; i < nailsCount; ++i) {
        const float angle = 2.f * std::numbers::pi_v<float> * static_cast<float>(i) / static_cast<float>(nailsCount);
        const short x = static_cast<short>(center.x + radiusW * std::cos(angle));
        const short y = static_cast<short>(center.y + radiusH * std::sin(angle));
        nails.emplace_back(std::clamp<short>(x, 0, w - 1), std::clamp<short>(y, 0, h - 1));
    }
}

StringArtGenerator::StringArtGenerator(const Image& input, std::pair<int, int> imageSize, size_t nailsCount, size_t maxConnections,
                                       std::span<const Color> threadColors, std::mt19937& gen)
    : maxIter(maxConnections) {
    targetImage = input;
    targetImage.resize(imageSize.first, imageSize.second);

    currentImage = Image(targetImage.width(), targetImage.height(), targetImage.channels());

    density.resize(currentImage.width() * currentImage.height(), 0);

    initializeNails(nailsCount, currentImage.width(), currentImage.height());

    std::uniform_int_distribution<> dis(0, nailsCount - 1);
    for (auto&& color : threadColors) {
        threads.emplace_back(color, dis(gen));
    }

    ocl = std::make_unique<OpenCLManager>(currentImage.width(), currentImage.height());
}

void StringArtGenerator::generate(const float alpha, const float kDensity) {
    ocl->setupResources(targetImage, currentImage, density, nails, threads, maxIter);
    ocl->loadProgram("kernels/kernel.cl");
    ocl->setupArgs(alpha, kDensity);

    for (unsigned int i = 0; i < maxIter; ++i) {
        ocl->runScores();
        ocl->runMinReduction(); // issue: CPU overhead
        ocl->runDraw(i);
    }
    ocl->finish();

    ocl->downloadResult(currentImage);

    std::vector<uint32_t> rawSeq(maxIter * 2);
    ocl->downloadSequence(rawSeq);
    sequence.reserve(maxIter);
    for (size_t i = 0; i < maxIter; ++i) {
        uint32_t tIdx = rawSeq[i * 2];
        uint32_t nIdx = rawSeq[i * 2 + 1];
        sequence.emplace_back(threads[tIdx].color, nIdx);
    }
}

Image StringArtGenerator::getResultImage() {
    Image out(targetImage.width(), targetImage.height(), 4);
    ocl->downloadResult(out);
    return out;
}

const std::vector<std::pair<Color, uint32_t>>& StringArtGenerator::getSequence() const { return sequence; }

std::vector<std::pair<Color, uint32_t>> StringArtGenerator::loadSequence(const std::string_view filename) {
    std::ifstream fin(filename.data());
    std::vector<std::pair<Color, uint32_t>> sequences;

    sequences.reserve(std::count(std::istreambuf_iterator<char>(fin), std::istreambuf_iterator<char>(), '\n'));
    fin.clear();
    fin.seekg(0);

    while (!fin.eof()) {
        short r, g, b, nailInd;
        fin >> r >> g >> b >> nailInd;

        sequences.emplace_back(Color{{static_cast<uint8_t>(r), static_cast<uint8_t>(g), static_cast<uint8_t>(b)}}, nailInd);
    }

    return sequences;
}

const Image& StringArtGenerator::rebuildFromSequence(std::span<const std::pair<Color, uint32_t>> sequences, const float alpha) {
    std::unordered_map<Color, size_t> colorToCurrentNail;

    for (const auto& entry : sequences) {
        const Color& color = entry.first;
        const size_t currentNail = entry.second;

        const auto it = colorToCurrentNail.find(color);
        if (it != colorToCurrentNail.end()) {
            const size_t prevNail = it->second;

            Point2s start = nails[prevNail];
            Point2s end = nails[currentNail];

            int x0 = start.x;
            int y0 = start.y;
            int x1 = end.x;
            int y1 = end.y;

            int dx = std::abs(x1 - x0);
            int dy = std::abs(y1 - y0);
            int sx = (x0 < x1) ? 1 : -1;
            int sy = (y0 < y1) ? 1 : -1;
            int err = dx - dy;

            while (true) {
                uint8_t* pixel = currentImage(x0, y0);
                for (int i = 0; i < 3; ++i) {
                    pixel[i] = static_cast<uint8_t>(color[i] * alpha + pixel[i] * (1.0f - alpha));
                }

                if (x0 == x1 && y0 == y1) {
                    break;
                }

                int e2 = 2 * err;
                if (e2 > -dy) {
                    err -= dy;
                    x0 += sx;
                }
                if (e2 < dx) {
                    err += dx;
                    y0 += sy;
                }
            }
        }

        colorToCurrentNail[color] = currentNail;
    }

    return currentImage;
}
