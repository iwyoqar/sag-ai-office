// What a hire check means for the person hiring, in plain words (pure, tested in test/marketplace.test.ts).
import type { HireCheck, HireOutcome } from "@sag/shared";

export function outcomeLabel(outcome: HireOutcome, checks: HireCheck[]): { tone: "ok" | "warn" | "bad"; text: string } {
  const failing = (hard: boolean) => checks.filter((c) => c.hard === hard && !c.ok).map((c) => c.detail).join("; ");
  if (outcome === "hire") return { tone: "ok", text: "darhol yollanadi" };
  if (outcome === "pending") return { tone: "warn", text: `admin tasdig'iga boradi: ${failing(false)}` };
  return { tone: "bad", text: `rad etiladi: ${failing(true)}` };
}

/** UZS from tiyin, thousands separated by spaces; 0 means the template has no price yet. */
export function formatUzs(minor: number): string {
  if (!minor) return "narx kiritilmagan";
  return `${String(Math.round(minor / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} so'm`;
}
