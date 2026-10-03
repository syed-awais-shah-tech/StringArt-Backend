/**
 * nailGenerator.js
 * Ports StringArtGenerator::initializeNails() from StringArt.cpp.
 *
 * Places nailsCount nails evenly around a circle inscribed in the
 * image rectangle, matching the C++ implementation exactly.
 */

/**
 * Generate nail positions on a circular layout.
 * @param {number} nailsCount - Number of nails to place
 * @param {number} w - Image width in pixels
 * @param {number} h - Image height in pixels
 * @returns {{ x: number, y: number }[]} Array of nail {x, y} positions
 */
export function generateNails(nailsCount, w, h) {
  const radiusW = Math.floor(w / 2) - 1;
  const radiusH = Math.floor(h / 2) - 1;
  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);

  const nails = [];
  for (let i = 0; i < nailsCount; i++) {
    const angle = (2 * Math.PI * i) / nailsCount;
    const x = Math.round(cx + radiusW * Math.cos(angle));
    const y = Math.round(cy + radiusH * Math.sin(angle));
    nails.push({
      x: Math.max(0, Math.min(w - 1, x)),
      y: Math.max(0, Math.min(h - 1, y)),
    });
  }
  return nails;
}
