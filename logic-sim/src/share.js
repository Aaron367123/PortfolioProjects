/**
 * Compact text encoding of a circuit for share links (URL hash).
 *
 * Format: one prefix letter + base64url payload.
 *   'z' - UTF-8 JSON compressed with raw DEFLATE (CompressionStream)
 *   'j' - UTF-8 JSON, uncompressed (fallback when CompressionStream is missing)
 * Both browsers and Node >= 18 provide CompressionStream, TextEncoder, btoa.
 */
import { toJSON, fromJSON } from './serialize.js';

const hasCompression = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

function toBase64Url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** circuit -> 'z...' (or 'j...' without CompressionStream). */
export async function encodeCircuit(circuit, { compress = true } = {}) {
  const bytes = new TextEncoder().encode(JSON.stringify(toJSON(circuit)));
  if (compress && hasCompression()) return 'z' + toBase64Url(await pipe(bytes, new CompressionStream('deflate-raw')));
  return 'j' + toBase64Url(bytes);
}

/** Inverse of encodeCircuit; validates the result. */
export async function decodeCircuit(text) {
  const kind = text[0];
  let bytes = fromBase64Url(text.slice(1));
  if (kind === 'z') bytes = await pipe(bytes, new DecompressionStream('deflate-raw'));
  else if (kind !== 'j') throw new Error('unrecognised share code');
  return fromJSON(new TextDecoder().decode(bytes));
}
