import { describe, expect, it } from "vitest";
import type { HireCheck } from "@sag/shared";
import { formatUzs, outcomeLabel } from "../src/ui/marketplace/outcome";

const C = (id: HireCheck["id"], ok: boolean, hard: boolean, detail: string): HireCheck => ({ id, ok, hard, detail });

describe("marketplace outcome", () => {
  it("outcomeLabel maps each outcome with the failing details", () => {
    expect(outcomeLabel("hire", [C("risk", true, false, "xavf: LOW")])).toEqual({ tone: "ok", text: "darhol yollanadi" });
    expect(outcomeLabel("pending", [C("agent_count", false, false, "agentlar: 3/3"), C("budget", false, false, "byudjet"), C("risk", true, false, "ok")]))
      .toEqual({ tone: "warn", text: "admin tasdig'iga boradi: agentlar: 3/3; byudjet" });
    expect(outcomeLabel("reject", [C("template_approved", false, true, "andoza eskirgan"), C("auto_listed", false, false, "yo'q")]))
      .toEqual({ tone: "bad", text: "rad etiladi: andoza eskirgan" });
  });

  it("formatUzs shows missing prices and so'm with thousand separators", () => {
    expect(formatUzs(0)).toBe("narx kiritilmagan");
    expect(formatUzs(125_000_000)).toBe("1 250 000 so'm");
  });
});
