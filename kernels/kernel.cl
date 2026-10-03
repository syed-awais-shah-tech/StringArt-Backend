typedef struct __attribute__ ((aligned (16))) {
    uchar4 color;
    uint currentNail;
    uint padding[2];
} GpuThread;

kernel void calculate_scores(
    global const uchar4* original,
    global const uchar4* current,
    global const ushort2* nails,
    global const ushort* density,
    global float* output_scores,
    global const GpuThread* threads,
    const uint count_threads,
    const uint count_nails,
    const uint width,
    const float alpha,
    const float kDensity)
{
    int target_nail = get_global_id(0);
    int thread_idx = get_global_id(1);

    if (thread_idx >= count_threads || target_nail >= count_nails) return;

    GpuThread t = threads[thread_idx];

    if (target_nail == t.currentNail) {
        output_scores[thread_idx * count_nails + target_nail] = 1e30f;
        return;
    }

    ushort2 start = nails[t.currentNail];
    ushort2 end = nails[target_nail];
    
    float total_diff = 0.0f;
    float total_density = 0.0f;
    int length = 0;

    float4 color_f = convert_float4(t.color);

    int dx = abs((int)end.x - (int)start.x);
    int dy = abs((int)end.y - (int)start.y);
    int sx = start.x < end.x ? 1 : -1;
    int sy = start.y < end.y ? 1 : -1;
    int x = start.x;
    int y = start.y;
    int err = (dx > dy ? dx : -dy) / 2;
    int e2;
    while (true) {
        uint idx = y * width + x;

        const float4 orig_f  = convert_float4(original[idx]);
        const float4 curr_f  = convert_float4(current[idx]);
        
        const float4 blended_f = color_f * alpha + curr_f * (1.0f - alpha);
        const float4 diff = orig_f - blended_f;
        const float4 diff_curr = orig_f - curr_f;

        float4 val = (diff - diff_curr) * (diff + diff_curr);
        float2 line_vec = normalize((float2)(end.x - start.x, end.y - start.y));
        total_diff += (fmin(val.x, 0.0f) + fmin(val.y, 0.0f) + fmin(val.z, 0.0f));
        total_density += (float)density[idx];
        length++;

        if (x == end.x && y == end.y) break;
        
        e2 = err;
        if (e2 > -dx) { err -= dy; x += sx; }
        if (e2 <  dy) { err += dx; y += sy; }
    }

    output_scores[thread_idx * count_nails + target_nail] = ((float)total_diff + kDensity * (float)total_density) / (float)length;
}
kernel void find_min(
    global const float* scores,
    global uint* best_result,
    const uint total_elements,
    const uint count_nails,
    local float* local_min_values,
    local uint* local_min_indices) 
{
    uint gid = get_global_id(0);
    uint lid = get_local_id(0);
    uint group_size = get_local_size(0);

    // 1. Каждый поток загружает данные из глобальной памяти в локальную
    float private_min = 1e30f;
    uint private_idx = 0;

    // Если элементов больше чем потоков, каждый поток проходит несколько элементов
    for (uint i = gid; i < total_elements; i += get_global_size(0)) {
        if (scores[i] < private_min) {
            private_min = scores[i];
            private_idx = i;
        }
    }

    local_min_values[lid] = private_min;
    local_min_indices[lid] = private_idx;
    barrier(CLK_LOCAL_MEM_FENCE);

    // 2. Древовидная редукция внутри рабочей группы
    for (uint s = group_size / 2; s > 0; s >>= 1) {
        if (lid < s) {
            if (local_min_values[lid + s] < local_min_values[lid]) {
                local_min_values[lid] = local_min_values[lid + s];
                local_min_indices[lid] = local_min_indices[lid + s];
            }
        }
        barrier(CLK_LOCAL_MEM_FENCE);
    }

    if (lid == 0) {
        uint final_idx = local_min_indices[0];
        best_result[0] = final_idx / count_nails;
        best_result[1] = final_idx % count_nails;
    }
}

kernel void draw_line(
    global uchar4* current,
    global ushort* density,
    global const ushort2* nails,
    global GpuThread* threads,
    global const uint* best_result,
    const uint width,
    const float alpha,
    global uint* sequence,
    const uint iter
) {
    uint thread_idx = best_result[0];
    uint end_nail   = best_result[1];

    ushort2 start = nails[threads[thread_idx].currentNail];
    ushort2 end   = nails[end_nail];

    int x0 = start.x;
    int y0 = start.y;
    int x1 = end.x;
    int y1 = end.y;

    int dx = abs(x1 - x0);
    int dy = abs(y1 - y0);
    int sx = (x0 < x1) ? 1 : -1;
    int sy = (y0 < y1) ? 1 : -1;

    int N = max(dx, dy);

    uint t = get_global_id(0);
    if (t > N) return;

    int x, y;
    if (dx >= dy) {
        x = x0 + t * sx;
        y = y0 + ((2 * t * dy + dx) / (2 * dx)) * sy;
    } else {
        y = y0 + t * sy;
        x = x0 + ((2 * t * dx + dy) / (2 * dy)) * sx;
    }

    uint idx = y * width + x;

    // fixed-point blending
    uint a   = (uint)(alpha * 256.0f);
    uint inv = 256 - a;

    uchar4 c = current[idx];
    uchar3 src = c.xyz;
    uchar3 col = threads[thread_idx].color.xyz;

    src.x = (uchar)((src.x * inv + col.x * a) >> 8);
    src.y = (uchar)((src.y * inv + col.y * a) >> 8);
    src.z = (uchar)((src.z * inv + col.z * a) >> 8);

    current[idx].xyz = src;

    density[idx] += 1;

    if (t == N) {
        threads[thread_idx].currentNail = end_nail;
        sequence[iter * 2 + 0] = thread_idx;
        sequence[iter * 2 + 1] = end_nail;
    }
}
