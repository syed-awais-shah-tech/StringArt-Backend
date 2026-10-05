/**
 * palette.js — Canonical Thread Color Palettes for StringArt Engine
 *
 * Rules:
 *   - Only two supported modes: 'black_only' and 'eight_color'.
 *   - Arbitrary client colors are strictly prohibited.
 *   - Exact 8-color palette: Black, White, Red, Green, Blue, Magenta, Cyan, Yellow.
 *   - Fixed Blue [0, 0, 255] replacing the previously duplicated Green [0, 255, 0].
 */

export const THREAD_MODES = {
  BLACK_ONLY: 'black_only',
  EIGHT_COLOR: 'eight_color',
};

export const COLOR_DEFINITIONS = {
  BLACK:   [0, 0, 0],
  WHITE:   [255, 255, 255],
  RED:     [255, 0, 0],
  GREEN:   [0, 255, 0],
  BLUE:    [0, 0, 255],
  MAGENTA: [255, 0, 255],
  CYAN:    [0, 255, 255],
  YELLOW:  [255, 255, 0],
};

// Canonical 8-color fixed palette
export const FIXED_EIGHT_COLOR_PALETTE = [
  COLOR_DEFINITIONS.BLACK,   // [0, 0, 0]
  COLOR_DEFINITIONS.WHITE,   // [255, 255, 255]
  COLOR_DEFINITIONS.RED,     // [255, 0, 0]
  COLOR_DEFINITIONS.GREEN,   // [0, 255, 0]
  COLOR_DEFINITIONS.BLUE,    // [0, 0, 255]
  COLOR_DEFINITIONS.MAGENTA, // [255, 0, 255]
  COLOR_DEFINITIONS.CYAN,    // [0, 255, 255]
  COLOR_DEFINITIONS.YELLOW,  // [255, 255, 0]
];

// Single black thread palette
export const BLACK_ONLY_PALETTE = [
  COLOR_DEFINITIONS.BLACK,   // [0, 0, 0]
];

/**
 * Resolve the authoritative palette and effective thread mode.
 *
 * @param {boolean} eightColorEnabled - Admin setting
 * @param {string} requestedMode - Customer requested mode ('black_only' | 'eight_color')
 * @returns {{ effectiveMode: 'black_only' | 'eight_color', colors: Array<[number, number, number]> }}
 */
export function resolveThreadModeAndColors(eightColorEnabled, requestedMode) {
  // If admin has 8-color disabled: ALWAYS use black thread
  if (!eightColorEnabled) {
    return {
      effectiveMode: THREAD_MODES.BLACK_ONLY,
      colors: BLACK_ONLY_PALETTE,
    };
  }

  // If admin has 8-color enabled: allow eight_color if explicitly requested, otherwise default to black_only
  if (requestedMode === THREAD_MODES.EIGHT_COLOR) {
    return {
      effectiveMode: THREAD_MODES.EIGHT_COLOR,
      colors: FIXED_EIGHT_COLOR_PALETTE,
    };
  }

  // Default to black_only
  return {
    effectiveMode: THREAD_MODES.BLACK_ONLY,
    colors: BLACK_ONLY_PALETTE,
  };
}
