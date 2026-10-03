/**
 * imageProcessor.js
 * Handles image loading, resizing, and preprocessing using `sharp`.
 *
 * Corresponds to the C++ Image class (stb_image based) plus the
 * brightness/contrast/background-threshold tuning parameters
 * exposed via the UI.
 */

import sharp from 'sharp';

/**
 * Process an uploaded image buffer into a raw RGBA Uint8Array
 * ready for the string-art generation engine.
 *
 * @param {Buffer} inputBuffer   Raw image file buffer from multer
 * @param {{
 *   size?: number,             Resize target (square), default 512
 *   brightness?: number,       Multiplier 0–2, default 1.0
 *   contrast?: number,         Multiplier 0–4, default 1.0
 *   bgThreshold?: number,      0–255 — grayscale pixels ABOVE this are set to 255 (background), 0 = disabled
 * }} options
 * @returns {Promise<{ data: Uint8Array, width: number, height: number }>}
 */
export async function processImage(inputBuffer, options = {}) {
  const {
    size = 512,
    brightness = 1.0,
    contrast = 1.0,
    bgThreshold = 0,
  } = options;

  // Apply contrast via linear transform: output = contrast * input + offset
  // offset keeps mid-grey (128) stable: offset = 128 - contrast * 128
  const contrastOffset = Math.round(128 - contrast * 128);

  let pipeline = sharp(inputBuffer)
    .resize(size, size, { fit: 'cover', position: 'centre' })
    .linear(contrast, contrastOffset)        // contrast adjustment
    .modulate({ brightness: brightness })     // brightness adjustment (1.0 = neutral)
    .ensureAlpha()                            // guarantee RGBA output
    .raw();

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });

  const rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  // Background threshold: pixels whose grayscale > bgThreshold → set to white
  if (bgThreshold > 0) {
    for (let i = 0; i < rgba.length; i += 4) {
      const gray = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      if (gray > bgThreshold) {
        rgba[i] = 255;
        rgba[i + 1] = 255;
        rgba[i + 2] = 255;
        rgba[i + 3] = 255;
      }
    }
  }

  return { data: rgba, width: info.width, height: info.height };
}
