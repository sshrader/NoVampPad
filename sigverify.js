'use strict';
// Checks a Solana wallet's signature over a text message, using only Node's own crypto (no packages).
// Wallets sign with ed25519; Phantom's signMessage returns the 64-byte signature.
const crypto = require('crypto');

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function base58Decode(s) {
  if (typeof s !== 'string' || !s) return null;
  let n = 0n;
  for (const ch of s) {
    const v = ALPHABET.indexOf(ch);
    if (v === -1) return null;
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  let bytes = n === 0n ? Buffer.alloc(0) : Buffer.from(hex, 'hex');
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  return Buffer.concat([Buffer.alloc(zeros), bytes]);
}

// address: the wallet's base58 public key. message: the exact text that was signed. signature: base64 (64 bytes).
function verifySignature(address, message, signature) {
  try {
    const pub = base58Decode(address);
    if (!pub || pub.length !== 32) return false;
    const sig = typeof signature === 'string' ? Buffer.from(signature, 'base64') : null;
    if (!sig || sig.length !== 64) return false;
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, pub]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(String(message), 'utf8'), key, sig);
  } catch (err) {
    return false;
  }
}

module.exports = { verifySignature, base58Decode };
