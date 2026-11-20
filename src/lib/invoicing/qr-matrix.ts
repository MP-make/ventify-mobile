/**
 * Pure TypeScript ISO/IEC 18004 QR Code Matrix Generator (Byte mode, Error Correction Level M, Versions 1..10).
 * Zero native or external dependencies; outputs crisp SVG path data for both `react-native-svg` and HTML/PDF printing.
 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

const RS_POLY_CACHE = new Map<number, Uint8Array>();

function getRsGeneratorPoly(ecCount: number): Uint8Array {
  const cached = RS_POLY_CACHE.get(ecCount);
  if (cached) return cached;

  let poly = new Uint8Array([1]);
  for (let i = 0; i < ecCount; i++) {
    const next = new Uint8Array(poly.length + 1);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  RS_POLY_CACHE.set(ecCount, poly);
  return poly;
}

function computeRsRemainder(data: Uint8Array, ecCount: number): Uint8Array {
  const gen = getRsGeneratorPoly(ecCount);
  const res = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ res[0];
    res.copyWithin(0, 1);
    res[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j++) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return res;
}

interface VersionSpecM {
  version: number;
  size: number;
  totalCodewords: number;
  ecPerBlock: number;
  // [blockCount, dataCodewordsPerBlock]
  groups: ReadonlyArray<readonly [number, number]>;
  alignments: readonly number[];
}

// Level M (15% recovery), Versions 1..10
const VERSION_SPECS_M: readonly VersionSpecM[] = [
  { version: 1, size: 21, totalCodewords: 26, ecPerBlock: 10, groups: [[1, 16]], alignments: [] },
  { version: 2, size: 25, totalCodewords: 44, ecPerBlock: 16, groups: [[1, 28]], alignments: [6, 18] },
  { version: 3, size: 29, totalCodewords: 70, ecPerBlock: 26, groups: [[1, 44]], alignments: [6, 22] },
  { version: 4, size: 33, totalCodewords: 100, ecPerBlock: 18, groups: [[2, 32]], alignments: [6, 26] },
  { version: 5, size: 37, totalCodewords: 134, ecPerBlock: 24, groups: [[2, 43]], alignments: [6, 30] },
  { version: 6, size: 41, totalCodewords: 172, ecPerBlock: 16, groups: [[4, 27]], alignments: [6, 34] },
  { version: 7, size: 45, totalCodewords: 196, ecPerBlock: 18, groups: [[4, 31]], alignments: [6, 22, 38] },
  { version: 8, size: 49, totalCodewords: 242, ecPerBlock: 22, groups: [[2, 38], [2, 39]], alignments: [6, 24, 42] },
  { version: 9, size: 53, totalCodewords: 292, ecPerBlock: 22, groups: [[3, 36], [2, 37]], alignments: [6, 26, 46] },
  { version: 10, size: 57, totalCodewords: 346, ecPerBlock: 26, groups: [[4, 43], [1, 44]], alignments: [6, 28, 50] },
];

// BCH(15,5) format bits for Level M (00) + mask pattern 0..7, pre-masked with 0x5412
const FORMAT_BITS_M: readonly number[] = [
  0x5412 ^ 0x0000, // placeholder replaced below via runtime BCH computation for 100% accuracy
];

function computeBchFormatInfo(ecLevelBits: number, maskPattern: number): number {
  const data = (ecLevelBits << 3) | maskPattern;
  let rem = data << 10;
  const gen = 0x537;
  for (let bit = 14; bit >= 10; bit--) {
    if ((rem >> bit) & 1) {
      rem ^= gen << (bit - 10);
    }
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function computeBchVersionInfo(version: number): number {
  let rem = version << 12;
  const gen = 0x1f25;
  for (let bit = 17; bit >= 12; bit--) {
    if ((rem >> bit) & 1) {
      rem ^= gen << (bit - 12);
    }
  }
  return (version << 12) | rem;
}

void FORMAT_BITS_M;

function utf8Encode(text: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text);
  }
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

function buildDataCodewords(payloadBytes: Uint8Array, spec: VersionSpecM): Uint8Array {
  const totalDataCodewords = spec.groups.reduce((sum, [cnt, dc]) => sum + cnt * dc, 0);
  const lengthBits = spec.version <= 9 ? 8 : 16;
  const bits: number[] = [];

  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >> i) & 1);
    }
  };

  // Byte mode indicator: 0100
  pushBits(0b0100, 4);
  pushBits(payloadBytes.length, lengthBits);
  for (let i = 0; i < payloadBytes.length; i++) {
    pushBits(payloadBytes[i], 8);
  }

  const maxBits = totalDataCodewords * 8;
  // Terminator up to 4 zero bits
  const terminatorLen = Math.min(4, maxBits - bits.length);
  for (let i = 0; i < terminatorLen; i++) bits.push(0);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);

  const out = new Uint8Array(totalDataCodewords);
  for (let i = 0; i < bits.length / 8; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) {
      b = (b << 1) | bits[i * 8 + j];
    }
    out[i] = b;
  }

  let padToggle = 0;
  for (let i = bits.length / 8; i < totalDataCodewords; i++) {
    out[i] = padToggle % 2 === 0 ? 0xec : 0x11;
    padToggle++;
  }
  return out;
}

function buildFinalBitStream(payloadBytes: Uint8Array, spec: VersionSpecM): Uint8Array {
  const rawData = buildDataCodewords(payloadBytes, spec);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;

  for (const [count, dc] of spec.groups) {
    for (let b = 0; b < count; b++) {
      const slice = rawData.subarray(offset, offset + dc);
      offset += dc;
      dataBlocks.push(slice);
      ecBlocks.push(computeRsRemainder(slice, spec.ecPerBlock));
    }
  }

  const interleaved: number[] = [];
  const maxDataLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDataLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) interleaved.push(blk[i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const blk of ecBlocks) {
      if (i < blk.length) interleaved.push(blk[i]);
    }
  }

  const totalRemainderBits = spec.version >= 2 && spec.version <= 6 ? 7 : 0;
  const totalBits = interleaved.length * 8 + totalRemainderBits;
  const bitStream = new Uint8Array(totalBits);
  for (let i = 0; i < interleaved.length; i++) {
    const byteVal = interleaved[i];
    for (let bit = 0; bit < 8; bit++) {
      bitStream[i * 8 + bit] = (byteVal >> (7 - bit)) & 1;
    }
  }
  return bitStream;
}

function placeFunctionPatterns(spec: VersionSpecM): {
  modules: Uint8Array;
  isFunction: Uint8Array;
} {
  const n = spec.size;
  const modules = new Uint8Array(n * n);
  const isFunction = new Uint8Array(n * n);

  const setFunc = (r: number, c: number, dark: boolean) => {
    modules[r * n + c] = dark ? 1 : 0;
    isFunction[r * n + c] = 1;
  };

  const drawFinder = (top: number, left: number) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const r = top + dy;
        const c = left + dx;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        const maxDist = Math.max(Math.abs(dy - 3), Math.abs(dx - 3));
        const dark = maxDist === 3 || maxDist <= 1;
        setFunc(r, c, dark);
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, n - 7);
  drawFinder(n - 7, 0);

  // Timing patterns
  for (let i = 8; i < n - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  // Alignment patterns (skip corners overlapping finder patterns)
  const centers = spec.alignments;
  for (let i = 0; i < centers.length; i++) {
    for (let j = 0; j < centers.length; j++) {
      const cy = centers[i];
      const cx = centers[j];
      if ((i === 0 && j === 0) || (i === 0 && j === centers.length - 1) || (i === centers.length - 1 && j === 0)) {
        continue;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const dist = Math.max(Math.abs(dy), Math.abs(dx));
          setFunc(cy + dy, cx + dx, dist === 2 || dist === 0);
        }
      }
    }
  }

  // Dark module
  setFunc(n - 8, 8, true);

  // Reserve Format Information modules (written properly per mask)
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      isFunction[8 * n + i] = 1;
      isFunction[i * n + 8] = 1;
    }
  }
  for (let i = 0; i < 8; i++) {
    isFunction[8 * n + (n - 1 - i)] = 1;
  }
  for (let i = 0; i < 7; i++) {
    isFunction[(n - 1 - i) * n + 8] = 1;
  }

  // Version Info (V7+)
  if (spec.version >= 7) {
    const verBits = computeBchVersionInfo(spec.version);
    for (let i = 0; i < 18; i++) {
      const bit = Boolean((verBits >> i) & 1);
      const a = Math.floor(i / 3);
      const b = (i % 3) + n - 11;
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  return { modules, isFunction };
}

function writeFormatInfo(modules: Uint8Array, n: number, mask: number): void {
  // EC level M is 0b00
  const fmt = computeBchFormatInfo(0b00, mask);

  // Copy 1 (top-left): LSB at (0, 8), MSB at (8, 0)
  for (let i = 0; i <= 5; i++) modules[i * n + 8] = (fmt >> i) & 1;
  modules[7 * n + 8] = (fmt >> 6) & 1;
  modules[8 * n + 8] = (fmt >> 7) & 1;
  modules[8 * n + 7] = (fmt >> 8) & 1;
  for (let i = 9; i < 15; i++) modules[8 * n + (14 - i)] = (fmt >> i) & 1;

  // Copy 2 (top-right + bottom-left): LSB at (8, n - 1), MSB at (n - 1, 8)
  for (let i = 0; i < 8; i++) modules[8 * n + (n - 1 - i)] = (fmt >> i) & 1;
  for (let i = 8; i < 15; i++) modules[(n - 15 + i) * n + 8] = (fmt >> i) & 1;
  modules[(n - 8) * n + 8] = 1;
}

function maskCondition(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    default: return false;
  }
}

function penaltyScore(modules: Uint8Array, n: number): number {
  let score = 0;

  // Rule 1: 5+ same color in row/col
  const evalRun = (isRow: boolean) => {
    for (let i = 0; i < n; i++) {
      let runColor = -1;
      let runLen = 0;
      for (let j = 0; j < n; j++) {
        const val = isRow ? modules[i * n + j] : modules[j * n + i];
        if (val === runColor) {
          runLen++;
        } else {
          if (runLen >= 5) score += 3 + (runLen - 5);
          runColor = val;
          runLen = 1;
        }
      }
      if (runLen >= 5) score += 3 + (runLen - 5);
    }
  };
  evalRun(true);
  evalRun(false);

  // Rule 2: 2x2 blocks
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = modules[r * n + c];
      if (
        v === modules[r * n + c + 1] &&
        v === modules[(r + 1) * n + c] &&
        v === modules[(r + 1) * n + c + 1]
      ) {
        score += 3;
      }
    }
  }

  // Rule 3: finder-like 1:1:3:1:1 patterns
  const evalFinderLike = (isRow: boolean) => {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j <= n - 11; j++) {
        let bits = 0;
        for (let k = 0; k < 11; k++) {
          const val = isRow ? modules[i * n + (j + k)] : modules[(j + k) * n + i];
          bits = (bits << 1) | val;
        }
        if (bits === 0b10111010000 || bits === 0b00001011101) {
          score += 40;
        }
      }
    }
  };
  evalFinderLike(true);
  evalFinderLike(false);

  // Rule 4: dark ratio balance
  let darkCount = 0;
  for (let i = 0; i < modules.length; i++) darkCount += modules[i];
  const pct = (darkCount * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;

  return score;
}

export interface QrMatrixResult {
  version: number;
  size: number;
  matrix: boolean[][];
  pathData: string;
}

interface QrCoreResult {
  version: number;
  size: number;
  modules: Uint8Array;
  pathData: string;
}

const QR_CORE_CACHE_LIMIT = 20;
const QR_CORE_CACHE = new Map<string, QrCoreResult>();

/**
 * Computes and caches QR modules + merged horizontal-run SVG path without allocating `boolean[][]`.
 */
function computeQrCore(text: string): QrCoreResult {
  const cacheKey = String(text || '');
  const cached = QR_CORE_CACHE.get(cacheKey);
  if (cached) {
    QR_CORE_CACHE.delete(cacheKey);
    QR_CORE_CACHE.set(cacheKey, cached);
    return cached;
  }

  const bytes = utf8Encode(cacheKey);
  let spec = VERSION_SPECS_M[VERSION_SPECS_M.length - 1];

  for (const candidate of VERSION_SPECS_M) {
    const totalDataCodewords = candidate.groups.reduce((sum, [cnt, dc]) => sum + cnt * dc, 0);
    const overheadBits = 4 + (candidate.version <= 9 ? 8 : 16);
    const maxBytes = Math.floor((totalDataCodewords * 8 - overheadBits) / 8);
    if (bytes.length <= maxBytes) {
      spec = candidate;
      break;
    }
  }

  const totalDataCodewords = spec.groups.reduce((sum, [cnt, dc]) => sum + cnt * dc, 0);
  const overheadBits = 4 + (spec.version <= 9 ? 8 : 16);
  const maxBytes = Math.floor((totalDataCodewords * 8 - overheadBits) / 8);
  const trimmedBytes = bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;

  const bitStream = buildFinalBitStream(trimmedBytes, spec);
  const { modules: baseModules, isFunction } = placeFunctionPatterns(spec);
  const n = spec.size;

  // Place data bits in zig-zag order
  let bitIdx = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? n - 1 - vert : vert;
        if (!isFunction[r * n + c] && bitIdx < bitStream.length) {
          baseModules[r * n + c] = bitStream[bitIdx++];
        }
      }
    }
  }

  let bestScore = Infinity;
  let bestModules = baseModules;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = new Uint8Array(baseModules);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!isFunction[r * n + c] && maskCondition(mask, r, c)) {
          candidate[r * n + c] ^= 1;
        }
      }
    }
    writeFormatInfo(candidate, n, mask);
    const score = penaltyScore(candidate, n);
    if (score < bestScore) {
      bestScore = score;
      bestModules = candidate;
    }
  }

  const pathParts: string[] = [];
  for (let r = 0; r < n; r++) {
    const rowOffset = r * n;
    let c = 0;
    while (c < n) {
      if (bestModules[rowOffset + c] === 1) {
        const startC = c;
        c++;
        while (c < n && bestModules[rowOffset + c] === 1) {
          c++;
        }
        const runLen = c - startC;
        pathParts.push(`M${startC} ${r}h${runLen}v1h-${runLen}z`);
      } else {
        c++;
      }
    }
  }

  const core: QrCoreResult = {
    version: spec.version,
    size: n,
    modules: bestModules,
    pathData: pathParts.join(''),
  };

  if (QR_CORE_CACHE.size >= QR_CORE_CACHE_LIMIT) {
    const oldestKey = QR_CORE_CACHE.keys().next().value;
    if (oldestKey !== undefined) {
      QR_CORE_CACHE.delete(oldestKey);
    }
  }
  QR_CORE_CACHE.set(cacheKey, core);
  return core;
}

/**
 * Codifica cualquier texto (p. ej. cadena QR SUNAT o URL) en matriz QR binaria
 * con corrección de errores Nivel M.
 */
export function generateQrMatrix(text: string): QrMatrixResult {
  const core = computeQrCore(text);
  const n = core.size;
  const matrix: boolean[][] = new Array(n);
  for (let r = 0; r < n; r++) {
    const row: boolean[] = new Array(n);
    const rowOffset = r * n;
    for (let c = 0; c < n; c++) {
      row[c] = core.modules[rowOffset + c] === 1;
    }
    matrix[r] = row;
  }

  return {
    version: core.version,
    size: n,
    matrix,
    pathData: core.pathData,
  };
}

/**
 * Genera markup `<svg>` inline autocontenido listo para embeber en HTML / `expo-print`.
 */
export function buildQrSvgMarkup(text: string, sizePx: number = 128, quietZone: number = 2): string {
  const { size, pathData } = computeQrCore(text);
  const totalViewBox = size + quietZone * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" ` +
    `viewBox="${-quietZone} ${-quietZone} ${totalViewBox} ${totalViewBox}" shape-rendering="crispEdges">` +
    `<rect x="${-quietZone}" y="${-quietZone}" width="${totalViewBox}" height="${totalViewBox}" fill="#ffffff"/>` +
    `<path d="${pathData}" fill="#000000"/>` +
    `</svg>`
  );
}
