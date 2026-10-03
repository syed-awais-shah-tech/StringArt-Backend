/**
 * sequenceFormatter.js
 * Formats the raw generated sequence into the "StringBoard Sequence File" format.
 *
 * Output format:
 *   # StringBoard Sequence File
 *   # name: myStringArt
 *   # pattern: circle
 *   # num_nails: {N}
 *   # board_diameter_mm: {D}
 *   # thread_thickness_mm: {T}
 *   # lines: {L}
 *   R G B nailIndex
 *   ...
 */

/**
 * @param {Array<{r:number, g:number, b:number, nailIdx:number}>} sequence
 * @param {{
 *   name?: string,
 *   numNails: number,
 *   boardDiameterMm: number,
 *   threadThicknessMm: number,
 * }} meta
 * @returns {string} Full formatted sequence file content
 */
export function formatSequence(sequence, meta) {
  const {
    name = 'myStringArt',
    numNails,
    boardDiameterMm,
    threadThicknessMm,
  } = meta;

  const lines = sequence.length;

  const header = [
    '# StringBoard Sequence File',
    `# name: ${name}`,
    `# pattern: circle`,
    `# num_nails: ${numNails}`,
    `# board_diameter_mm: ${boardDiameterMm}`,
    `# thread_thickness_mm: ${threadThicknessMm}`,
    `# lines: ${lines}`,
  ].join('\n');

  const body = sequence
    .map((s) => `${s.r} ${s.g} ${s.b} ${s.nailIdx}`)
    .join('\n');

  return `${header}\n${body}\n`;
}
