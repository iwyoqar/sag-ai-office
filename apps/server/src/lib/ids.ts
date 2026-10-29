import { randomBytes, randomUUID } from "node:crypto";

export const uid = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
export const token = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .slice(0, 40);
}
