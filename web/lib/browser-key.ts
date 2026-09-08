// Operator authorization keys, generated in the browser.
//
// This file is the whole non-custodial claim. The private half of an operator's
// key is created by WebCrypto inside their tab and is never sent anywhere: the
// only value that crosses to our server is `publicKey`, which is all a Privy key
// quorum has ever needed. That is a structural guarantee rather than a promise
// about our logging.
//
// Two format details that are easy to get wrong and silent when wrong:
//
//  1. Privy wants base64 **SPKI DER** for public keys and base64 **PKCS#8 DER**
//     for the private half in `.env`. WebCrypto exports exactly those, so the
//     bytes match what `buyer/org/authorization-key.ts` produces with Node.
//
//  2. Privy verifies **DER-encoded** ECDSA signatures. Node's `crypto.sign`
//     emits DER already, which is why the server-side code never mentions this.
//     **WebCrypto does not** — it emits the raw r‖s pair from IEEE P1363. A raw
//     signature is well-formed, the right length, and rejected. `derFromRaw`
//     below converts it.

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export interface BrowserKeyPair {
  /** base64 SPKI DER. Sent to the server; goes into the key quorum. */
  publicKey: string;
  /** base64 PKCS#8 DER. Stays in this tab. Belongs in the operator's own .env. */
  privateKey: string;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function generateBrowserKey(): Promise<BrowserKeyPair> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const [spki, pkcs8] = await Promise.all([
    crypto.subtle.exportKey('spki', pair.publicKey),
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
  ]);
  return { publicKey: toBase64(spki), privateKey: toBase64(pkcs8) };
}

/**
 * IEEE P1363 `r‖s` (what WebCrypto signs with) to the DER SEQUENCE Privy wants.
 *
 * Each half is a fixed 32 bytes for P-256 and must become a DER INTEGER, which
 * is signed: a leading byte >= 0x80 needs a 0x00 prefix or it reads as negative,
 * and leading zeros are otherwise stripped. Getting this wrong produces a
 * signature that is rejected rather than one that errors, so it is worth the
 * explicit code.
 */
export function derFromRaw(raw: Uint8Array): Uint8Array {
  if (raw.length !== 64) throw new Error(`expected a 64-byte P-256 signature, got ${raw.length}`);

  const encodeInteger = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
    const trimmed = Array.from(bytes.slice(start));
    if ((trimmed[0]! & 0x80) !== 0) trimmed.unshift(0x00);
    return [0x02, trimmed.length, ...trimmed];
  };

  const body = [...encodeInteger(raw.slice(0, 32)), ...encodeInteger(raw.slice(32))];
  return new Uint8Array([0x30, body.length, ...body]);
}

/** Sign a canonical payload the way Privy's `privy-authorization-signature` wants. */
export async function signWithBrowserKey(privateKeyBase64: string, payload: string): Promise<string> {
  const der = Uint8Array.from(atob(privateKeyBase64), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, ALGORITHM, false, ['sign']);
  const raw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(payload)),
  );
  return toBase64(derFromRaw(raw).buffer as ArrayBuffer);
}
