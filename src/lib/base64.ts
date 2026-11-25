const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * Encodes a Uint8Array binary buffer to a Base64 string without Node Buffer dependencies.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  if (len === 0) return '';

  const chunkCount = Math.ceil(len / 3);
  const out = new Array<string>(chunkCount);
  const fullTripletsEnd = len - (len % 3);
  let outIdx = 0;

  for (let i = 0; i < fullTripletsEnd; i += 3) {
    const triplet = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[outIdx++] =
      BASE64_CHARS[(triplet >> 18) & 0x3f] +
      BASE64_CHARS[(triplet >> 12) & 0x3f] +
      BASE64_CHARS[(triplet >> 6) & 0x3f] +
      BASE64_CHARS[triplet & 0x3f];
  }

  const rem = len - fullTripletsEnd;
  if (rem === 1) {
    const b1 = bytes[fullTripletsEnd];
    out[outIdx++] =
      BASE64_CHARS[b1 >> 2] +
      BASE64_CHARS[(b1 & 0x03) << 4] +
      '==';
  } else if (rem === 2) {
    const b1 = bytes[fullTripletsEnd];
    const b2 = bytes[fullTripletsEnd + 1];
    out[outIdx++] =
      BASE64_CHARS[b1 >> 2] +
      BASE64_CHARS[((b1 & 0x03) << 4) | (b2 >> 4)] +
      BASE64_CHARS[(b2 & 0x0f) << 2] +
      '=';
  }

  return out.join('');
}

export const toBase64 = uint8ArrayToBase64;
