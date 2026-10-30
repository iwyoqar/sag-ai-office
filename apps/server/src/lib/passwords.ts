import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

const scrypt = (pw: string, salt: Buffer, len: number, opts: ScryptOptions) =>
  new Promise<Buffer>((res, rej) => scryptCb(pw, salt, len, opts, (e, k) => (e ? rej(e) : res(k))));

let PARAMS = { N: 16384, r: 8, p: 1 };

/**
 * Test suites only: a cheap work factor for new hashes, so CPU-bound hashing does not decide whether a test
 * meets its timeout under parallel load. Verification always uses the parameters stored in the hash.
 */
export function setHashCostForTests(params: { N: number; r: number; p: number }) {
  PARAMS = params;
}

/**
 * A hash with the current work factor and an unguessable password, verified when the username does not exist, so a
 * missing account costs the same time as a wrong password (no username probing by timing).
 */
export function dummyHash(): string {
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${"A".repeat(22)}==$${"A".repeat(43)}=`;
}

/** Format: scrypt$N$r$p$saltB64$hashB64 */
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, N, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(pw, Buffer.from(salt, "base64"), expected.length, { N: +N, r: +r, p: +p });
  return timingSafeEqual(key, expected);
}
