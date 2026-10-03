#pragma once

#include <fstream>
#include <iostream>
#include <span>
#include <string_view>
#include <tuple>
#include <vector>

#include <CL/opencl.hpp>

#include "src/geometry/Point2.h"
#include "src/image/Image.h"
#include "src/utils/color_utils.h"

struct Thread {
    Color color;
    uint32_t currentNail;
};

struct alignas(16) GpuThread {
    cl_uchar4 color;
    cl_uint currentNail;
    uint32_t padding[2];

    GpuThread(Color c, uint32_t nail) : color{{c[0], c[1], c[2], 255}}, currentNail(nail) {}
};

class OpenCLManager {
private:
    cl::Context context;
    cl::CommandQueue queue;
    cl::Program program;

    struct {
        cl::Kernel scores;
        cl::Kernel draw;
        cl::Kernel findMin;
    } kernels;

    struct {
        cl::Buffer imgOriginal;
        cl::Buffer imgCurrent;
        cl::Buffer nails;
        cl::Buffer density;
        cl::Buffer scores;
        cl::Buffer threads;
        cl::Buffer bestResult;
        cl::Buffer sequence;
    } buffers;

    uint32_t width, height, nailsCount, threadsCount = 0;

    size_t maxWorkGroupSize;

public:
    OpenCLManager(uint32_t w, uint32_t h) : width(w), height(h) { initDevice(); }

    void initDevice() {
        std::vector<cl::Platform> platforms;
        cl::Platform::get(&platforms);
        if (platforms.empty()) {
            throw std::runtime_error("No OpenCL platforms found");
        }

        std::vector<cl::Device> devices;
        platforms[0].getDevices(CL_DEVICE_TYPE_ALL, &devices);
        if (devices.empty()) {
            throw std::runtime_error("No devices found");
        }

        context = cl::Context(devices[0]);

        queue = cl::CommandQueue(context, devices[0]);

        devices[0].getInfo(CL_DEVICE_MAX_WORK_GROUP_SIZE, &maxWorkGroupSize);
        if (maxWorkGroupSize > 1024) {
            maxWorkGroupSize = 1024;
        }
    }

    void setupResources(const Image& orig, const Image& current, std::span<const uint16_t> density, std::span<const Point2s> nails,
                        std::span<const Thread> threads, size_t maxIter) {
        if (orig.channels() != 4 || current.channels() != 4) {
            throw std::runtime_error("Images must be RGBA (4 channels)");
        }
        if (orig.width() != current.width() || orig.height() != current.height()) {
            throw std::runtime_error("Images must be the same size");
        }

        threadsCount = threads.size();
        nailsCount = nails.size();

        auto createBuffer = [&](cl_mem_flags flags, size_t size, void* ptr = nullptr) {
            cl_int err;
            cl::Buffer buf(context, flags | (ptr ? CL_MEM_COPY_HOST_PTR : 0), size, ptr, &err);
            if (err != CL_SUCCESS) {
                throw std::runtime_error("Failed to create OpenCL buffer, error code: " + std::to_string(err));
            }
            return buf;
        };

        buffers.imgOriginal =
            createBuffer(CL_MEM_READ_ONLY, width * height * orig.channels(), static_cast<void*>(const_cast<unsigned char*>(orig.data())));

        buffers.imgCurrent = createBuffer(CL_MEM_READ_WRITE, width * height * current.channels(),
                                          static_cast<void*>(const_cast<unsigned char*>(current.data())));

        buffers.density = createBuffer(CL_MEM_READ_WRITE, density.size_bytes(), static_cast<void*>(const_cast<uint16_t*>(density.data())));

        buffers.scores = createBuffer(CL_MEM_READ_WRITE, nails.size() * threads.size() * sizeof(float));

        buffers.threads =
            createBuffer(CL_MEM_READ_WRITE, threads.size() * sizeof(threads[0]), static_cast<void*>(const_cast<Thread*>(threads.data())));

        buffers.bestResult = createBuffer(CL_MEM_READ_WRITE, 2 * sizeof(cl_uint));

        buffers.sequence = createBuffer(CL_MEM_READ_WRITE, maxIter * 2 * sizeof(cl_uint));

        buffers.nails =
            createBuffer(CL_MEM_READ_ONLY, nails.size() * sizeof(nails[0]), static_cast<void*>(const_cast<Point2s*>(nails.data())));
    }

    void loadProgram(std::string_view filename) {
        std::ifstream file(filename.data());
        if (!file) {
            throw std::runtime_error("Kernel file not found: " + std::string(filename));
        }

        std::string source((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
        program = cl::Program(context, source);

        if (program.build({context.getInfo<CL_CONTEXT_DEVICES>()[0]}) != CL_SUCCESS) {
            throw std::runtime_error("OpenCL Build Error:\n" +
                                     program.getBuildInfo<CL_PROGRAM_BUILD_LOG>(context.getInfo<CL_CONTEXT_DEVICES>()[0]));
        }

        kernels.scores = cl::Kernel(program, "calculate_scores");
        kernels.findMin = cl::Kernel(program, "find_min");
        kernels.draw = cl::Kernel(program, "draw_line");
    }

    void setupArgs(float alpha, float kDensity) {
        unsigned int argInd = 0;

        auto& ks = kernels.scores;
        ks.setArg(argInd++, buffers.imgOriginal);
        ks.setArg(argInd++, buffers.imgCurrent);
        ks.setArg(argInd++, buffers.nails);
        ks.setArg(argInd++, buffers.density);
        ks.setArg(argInd++, buffers.scores);
        ks.setArg(argInd++, buffers.threads);
        ks.setArg(argInd++, static_cast<cl_uint>(threadsCount));
        ks.setArg(argInd++, static_cast<cl_uint>(nailsCount));
        ks.setArg(argInd++, static_cast<cl_uint>(width));
        ks.setArg(argInd++, alpha);
        ks.setArg(argInd++, kDensity);

        argInd = 0;
        auto& km = kernels.findMin;
        km.setArg(argInd++, buffers.scores);
        km.setArg(argInd++, buffers.bestResult);
        km.setArg(argInd++, static_cast<cl_uint>(nailsCount * threadsCount));
        km.setArg(argInd++, static_cast<cl_uint>(nailsCount));
        km.setArg(argInd++, cl::Local(maxWorkGroupSize * sizeof(float)));
        km.setArg(argInd++, cl::Local(maxWorkGroupSize * sizeof(cl_uint)));

        argInd = 0;
        auto& kd = kernels.draw;
        kd.setArg(argInd++, buffers.imgCurrent);
        kd.setArg(argInd++, buffers.density);
        kd.setArg(argInd++, buffers.nails);
        kd.setArg(argInd++, buffers.threads);
        kd.setArg(argInd++, buffers.bestResult);
        kd.setArg(argInd++, static_cast<cl_uint>(width));
        kd.setArg(argInd++, alpha);
        kd.setArg(argInd++, buffers.sequence);
    }

    void runScores() { queue.enqueueNDRangeKernel(kernels.scores, cl::NullRange, cl::NDRange(nailsCount, threadsCount)); }

    void runMinReduction() {
        queue.enqueueNDRangeKernel(kernels.findMin, cl::NullRange, cl::NDRange(maxWorkGroupSize), cl::NDRange(maxWorkGroupSize));
    }

    void runDraw(unsigned int iteration) {
        kernels.draw.setArg(8, static_cast<cl_uint>(iteration));
        queue.enqueueNDRangeKernel(kernels.draw, cl::NullRange, cl::NDRange(width));
    }

    void downloadResult(Image& out) { queue.enqueueReadBuffer(buffers.imgCurrent, CL_TRUE, 0, width * height * 4, out.data()); }

    void finish() { queue.finish(); }

    void downloadSequence(std::vector<uint32_t>& hostSeq) {
        queue.enqueueReadBuffer(buffers.sequence, CL_TRUE, 0, hostSeq.size() * sizeof(cl_uint), hostSeq.data());
    }
};