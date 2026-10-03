/**
 * scoreCalculator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * JavaScript port of the three OpenCL kernels from kernels/kernel.cl:
 *
 *  1. calculate_scores  — for every (thread × target_nail) pair, walk the
 *                         Bresenham line and compute a residual-error score.
 *  2. find_min          — pick the (thread, nail) pair with lowest score.
 *  3. draw_line         — alpha-blend the winning line onto the canvas,
 *                         increment the density map, record the sequence step.
 *
 * Optimisations used in lieu of GPU parallelism:
 *  • Typed arrays (Uint8Array, Uint16Array, Float64Array, Int16Array) for
 *    cache-friendly, JIT-friendly numeric storage.
 *  • Integer-only Bresenham (no floating-point inside the hot loop).
 *  • Pre-flattened nail coordinate arrays.
 *  • Pre-computed alpha fixed-point factors to replace repeated FP muls.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Score formula (from kernel.cl calculate_scores) ────────────────────────
//
//   blended = color * alpha + current * (1 - alpha)
//   diff      = original - blended          ← error after placing thread
//   diff_curr = original - current          ← error before placing thread
//   val = diff² - diff_curr²                ← (diff-diffC)*(diff+diffC)
//
//   We accumulate min(val, 0)  → only pixels where the thread IMPROVES fit.
//   score = (Σ min(val,0) + kDensity * Σ density) / length
//
//   The score is MINIMISED (most negative = best improvement, density penalises
//   already-dense paths).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run the full string-art generation loop.
 *
 * @param {{
 *   original:      Uint8Array,   RGBA flat array, width*height*4 bytes
 *   width:         number,
 *   height:        number,
 *   nails:         Array<{x:number, y:number}>,
 *   threads:       Array<{color:[number,number,number], currentNail:number}>,
 *   maxIterations: number,
 *   alpha:         number,       0–1 blending factor (default 0.13)
 *   kDensity:      number,       density penalty weight (default 500)
 *   onProgress?:   (pct:number, iter:number) => void
 * }} params
 *
 * @returns {{
 *   sequence: Array<{r:number, g:number, b:number, nailIdx:number}>,
 *   preview:  Uint8Array   RGBA canvas after all iterations
 * }}
 */
export function generate(params) {
  const {
    original,
    width,
    height,
    nails,
    threads,
    maxIterations,
    alpha = 0.13,
    kDensity = 500,
    onProgress,
  } = params;

  const nailCount = nails.length;
  const threadCount = threads.length;
  const pixelCount = width * height;

  // ── Flatten nail coordinates into typed arrays for cache efficiency ─────
  const nailsX = new Int16Array(nailCount);
  const nailsY = new Int16Array(nailCount);
  for (let i = 0; i < nailCount; i++) {
    nailsX[i] = nails[i].x;
    nailsY[i] = nails[i].y;
  }

  // ── Thread state ─────────────────────────────────────────────────────────
  // currentNail per thread
  const threadNail = new Int32Array(threadCount);
  // RGB colors flat: [r0,g0,b0, r1,g1,b1, ...]
  const threadColors = new Uint8Array(threadCount * 3);
  for (let ti = 0; ti < threadCount; ti++) {
    threadNail[ti] = threads[ti].currentNail;
    threadColors[ti * 3 + 0] = threads[ti].color[0];
    threadColors[ti * 3 + 1] = threads[ti].color[1];
    threadColors[ti * 3 + 2] = threads[ti].color[2];
  }

  // ── Canvas buffers ───────────────────────────────────────────────────────
  // current image — start all white (255) matching the C++ white canvas
  const current = new Uint8Array(pixelCount * 4).fill(255);
  // density map — how many threads have crossed each pixel
  const density = new Uint16Array(pixelCount);

  // ── Score buffer ─────────────────────────────────────────────────────────
  const scores = new Float64Array(threadCount * nailCount);

  // ── Pre-compute alpha factors ────────────────────────────────────────────
  const inv = 1.0 - alpha;

  // ── Output sequence ──────────────────────────────────────────────────────
  const sequence = [];

  // ── Main generation loop ─────────────────────────────────────────────────
  for (let iter = 0; iter < maxIterations; iter++) {

    // ── 1. calculate_scores ───────────────────────────────────────────────
    scores.fill(1e30);

    for (let ti = 0; ti < threadCount; ti++) {
      const curNailIdx = threadNail[ti];
      const sx = nailsX[curNailIdx];
      const sy = nailsY[curNailIdx];
      const cr = threadColors[ti * 3 + 0];
      const cg = threadColors[ti * 3 + 1];
      const cb = threadColors[ti * 3 + 2];

      for (let ni = 0; ni < nailCount; ni++) {
        // Skip current nail (score stays 1e30)
        if (ni === curNailIdx) continue;

        const ex = nailsX[ni];
        const ey = nailsY[ni];

        // ── Bresenham walk (matches kernel.cl calculate_scores variant) ──
        const dx = Math.abs(ex - sx);
        const dy = Math.abs(ey - sy);
        const stepX = sx < ex ? 1 : -1;
        const stepY = sy < ey ? 1 : -1;

        // kernel uses: err = (dx > dy ? dx : -dy) / 2
        let err = (dx > dy ? dx : -dy) >> 1;
        let x = sx;
        let y = sy;

        let totalDiff = 0;
        let totalDensity = 0;
        let length = 0;

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const pidx = (y * width + x) * 4;
          const didx = y * width + x;

          const origR = original[pidx];
          const origG = original[pidx + 1];
          const origB = original[pidx + 2];
          const currR = current[pidx];
          const currG = current[pidx + 1];
          const currB = current[pidx + 2];

          // blended = color * alpha + current * inv
          const blR = cr * alpha + currR * inv;
          const blG = cg * alpha + currG * inv;
          const blB = cb * alpha + currB * inv;

          // diff  = original - blended
          // diffC = original - current
          const difR = origR - blR;
          const difG = origG - blG;
          const difB = origB - blB;
          const dcR = origR - currR;
          const dcG = origG - currG;
          const dcB = origB - currB;

          // val = diff² - diffC²  (kernel: (diff - diffC)*(diff + diffC))
          const valR = difR * difR - dcR * dcR;
          const valG = difG * difG - dcG * dcG;
          const valB = difB * difB - dcB * dcB;

          // Only accumulate improvements (negative val)
          totalDiff += (valR < 0 ? valR : 0)
                     + (valG < 0 ? valG : 0)
                     + (valB < 0 ? valB : 0);
          totalDensity += density[didx];
          length++;

          if (x === ex && y === ey) break;

          // kernel: if (e2 > -dx) { err -= dy; x += sx; }
          //         if (e2 < dy)  { err += dx; y += sy; }
          const e2 = err;
          if (e2 > -dx) { err -= dy; x += stepX; }
          if (e2 < dy)  { err += dx; y += stepY; }
        }

        scores[ti * nailCount + ni] = (totalDiff + kDensity * totalDensity) / length;
      }
    }

    // ── 2. find_min ───────────────────────────────────────────────────────
    let bestScore = 1e30;
    let bestTi = 0;
    let bestNi = 0;
    for (let i = 0, n = threadCount * nailCount; i < n; i++) {
      if (scores[i] < bestScore) {
        bestScore = scores[i];
        bestTi = (i / nailCount) | 0;
        bestNi = i % nailCount;
      }
    }

    // ── 3. draw_line ──────────────────────────────────────────────────────
    const fromNail = threadNail[bestTi];
    const x0 = nailsX[fromNail];
    const y0 = nailsY[fromNail];
    const x1 = nailsX[bestNi];
    const y1 = nailsY[bestNi];
    const dr = threadColors[bestTi * 3 + 0];
    const dg = threadColors[bestTi * 3 + 1];
    const db = threadColors[bestTi * 3 + 2];

    _drawLine(current, density, x0, y0, x1, y1, dr, dg, db, alpha, inv, width);

    // Update thread position
    threadNail[bestTi] = bestNi;

    // Record sequence entry
    sequence.push({ r: dr, g: dg, b: db, nailIdx: bestNi });

    // Progress callback (every 1% or every 50 iters)
    if (onProgress && (iter % 50 === 0 || iter === maxIterations - 1)) {
      onProgress(((iter + 1) / maxIterations) * 100, iter + 1);
    }
  }

  return { sequence, preview: current };
}

// ─── Internal: draw_line ─────────────────────────────────────────────────────
// Ports rebuildFromSequence() Bresenham + StringArt.cpp alpha blend.
// Uses standard dx-dy Bresenham (matching the CPU rebuild path in C++).
// ─────────────────────────────────────────────────────────────────────────────
function _drawLine(current, density, x0, y0, x1, y1, cr, cg, cb, alpha, inv, width) {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const stepX = x0 < x1 ? 1 : -1;
  const stepY = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;

  while (true) {
    const pidx = (y * width + x) * 4;
    // Alpha blend: pixel[c] = color[c] * alpha + pixel[c] * (1-alpha)
    current[pidx]     = (cr * alpha + current[pidx]     * inv) | 0;
    current[pidx + 1] = (cg * alpha + current[pidx + 1] * inv) | 0;
    current[pidx + 2] = (cb * alpha + current[pidx + 2] * inv) | 0;
    // Alpha channel stays 255
    density[y * width + x]++;

    if (x === x1 && y === y1) break;

    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += stepX; }
    if (e2 <  dx) { err += dx; y += stepY; }
  }
}
