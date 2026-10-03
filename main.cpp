#include <fstream>
#include <iostream>
#include <random>
#include <string_view>

#include <argparse/argparse.hpp>

#include "src/string_art/StringArt.h"
#include "src/utils/io_utils.h"

using namespace std::string_view_literals;
using namespace std::string_literals;

std::vector<Color> parse_colors(const std::string& colors_str) {
    std::vector<Color> colors;
    std::vector<std::string> colorStrings = split(colors_str, ';');
    for (const auto& colorStr : colorStrings) {
        std::vector<std::string> components = split(colorStr, ':');
        if (components.size() != 3) {
            throw std::runtime_error("Invalid color format: " + colorStr + ". Expected format r:g:b.");
        }
        try {
            unsigned long r_ul = std::stoul(components[0]);
            unsigned long g_ul = std::stoul(components[1]);
            unsigned long b_ul = std::stoul(components[2]);

            if (r_ul > 255 || g_ul > 255 || b_ul > 255) {
                throw std::out_of_range("Color component out of range (0-255): " + colorStr);
            }

            uint8_t r = static_cast<uint8_t>(r_ul);
            uint8_t g = static_cast<uint8_t>(g_ul);
            uint8_t b = static_cast<uint8_t>(b_ul);
            colors.emplace_back(Color{{r, g, b}});
        }
        catch (const std::exception& e) {
            throw std::runtime_error("Error parsing color component for " + colorStr + ": " + e.what());
        }
    }
    return colors;
}

int main(int argc, char* argv[]) {
    std::string inputImage;
    std::string outputImage;
    std::string inputSequence;
    std::string outputSequence;
    int countNails;
    int maxIterations;
    float kDensity;
    float alpha;
    bool isLoadSequence;
    std::vector<int> sizeImage;

    argparse::ArgumentParser program("StringArt.exe");

    program.add_argument("-ii", "--input-image").default_value("input.png"s).store_into(inputImage).help("Input image path.");

    program.add_argument("-oi", "--output-image").default_value("output.png"s).store_into(outputImage).help("Output image path.");

    program.add_argument("-is", "--input-sequence").default_value("sequence.txt"s).store_into(inputSequence).help("Input sequence file.");

    program.add_argument("-os", "--output-sequence")
        .default_value("sequence.txt"s)
        .store_into(outputSequence)
        .help("Output sequence file.");

    program.add_argument("-n", "--nails").default_value(300).store_into(countNails).help("Number of nails.");

    program.add_argument("-it", "--max-iterations").default_value(10000).store_into(maxIterations).help("Maximum iterations.");

    program.add_argument("-kd", "--k-density").default_value(500.f).store_into(kDensity).help("Density parameter.");

    program.add_argument("-a", "--alpha").default_value(0.13f).store_into(alpha).help("Alpha blending value.");

    program.add_argument("-ls", "--load-sequence")
        .flag()
        .store_into(isLoadSequence)
        .help("Load existing sequence instead of generating a new one.");

    program.add_argument("-rs", "--resize")
        .nargs(2)
        .default_value(std::vector<int>{1024, 1024})
        .store_into(sizeImage)
        .help("Resize image to given width and height.");

    program.add_argument("-c", "--colors")
        .default_value("0:0:0;255:255:255;255:0:0;0:255:0;0:0:255;255:0:255;0:255:255;255:255:0"s)
        .help("Custom colors in RGB format.");

    try {
        program.parse_args(argc, argv);
    }
    catch (const std::runtime_error& err) {
        std::cerr << err.what() << std::endl;
        std::cerr << program;
        return 1;
    }

    std::vector<Color> colors;
    try {
        colors = parse_colors(program.get<std::string>("--colors"sv));
    }
    catch (const std::exception& e) {
        std::cerr << "Error parsing custom colors: " << e.what() << std::endl;
        return 1;
    }

    Image input;
    input.load(inputImage);

    std::mt19937 gen(std::random_device{}());
    StringArtGenerator generator(input, {sizeImage[0], sizeImage[1]}, countNails, maxIterations, colors, gen);

    if (isLoadSequence) {
        auto sequences = generator.loadSequence(inputSequence);
        const Image& result = generator.rebuildFromSequence(sequences, alpha);
        result.save(outputImage);
    }
    else {
        generator.generate(alpha, kDensity);

        Image result = generator.getResultImage();
        const auto sequence = generator.getSequence();

        result.save(outputImage);

        std::ofstream fout(outputSequence.data());
        for (auto&& [color, nailInd] : sequence) {
            short r = color[0];
            short g = color[1];
            short b = color[2];
            fout << r << ' ' << g << ' ' << b << ' ' << nailInd << '\n';
        }
    }

    return 0;
}
