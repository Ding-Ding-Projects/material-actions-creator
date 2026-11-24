// libsodium crypto_box_seal, which GitHub requires for Actions secrets:
// ephemeral X25519 key pair, nonce = BLAKE2b-192(ephemeral_pk || recipient_pk),
// output = ephemeral_pk || crypto_box(message).
import nacl from 'tweetnacl';
import blake from 'blakejs';

function nonceFor(epk, pk) {
  const both = new Uint8Array(epk.length + pk.length);
  both.set(epk);
  both.set(pk, epk.length);
  return blake.blake2b(both, undefined, nacl.box.nonceLength);
}

export function sealedBox(message, recipientPublicKeyB64) {
  const pk = new Uint8Array(Buffer.from(recipientPublicKeyB64, 'base64'));
  const msg = new Uint8Array(Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8'));
  const eph = nacl.box.keyPair();
  const boxed = nacl.box(msg, nonceFor(eph.publicKey, pk), pk, eph.secretKey);
  const out = new Uint8Array(eph.publicKey.length + boxed.length);
  out.set(eph.publicKey);
  out.set(boxed, eph.publicKey.length);
  return Buffer.from(out).toString('base64');
}

export function sealedBoxOpen(sealedB64, publicKey, secretKey) {
  const sealed = new Uint8Array(Buffer.from(sealedB64, 'base64'));
  const epk = sealed.subarray(0, nacl.box.publicKeyLength);
  const opened = nacl.box.open(sealed.subarray(nacl.box.publicKeyLength), nonceFor(epk, publicKey), epk, secretKey);
  return opened ? Buffer.from(opened) : null;
}
