import { useEffect, useState } from "react";
import { api } from "./client";
import { useOffice } from "./office";

export interface SystemStatus {
  llm: {
    configured: boolean;
    provider: string | null;
    model: string | null;
    mode: "live" | "mock" | null;
    reason?: string;
    health: { ok: boolean; model: string; detail?: string; checkedAt: string } | null;
  };
  worker: { running: boolean; active: number };
}

/** What powers the agents (Gemini live / mock / not configured). Polled slowly; also refreshed on events. */
export function useSystem() {
  const { auth, tick, unitAccount } = useOffice();
  const [s, setS] = useState<SystemStatus | null>(null);
  const [bucket, setBucket] = useState(0);
  useEffect(() => {
    const t = window.setTimeout(() => setBucket(tick), 3000);
    return () => window.clearTimeout(t);
  }, [tick]);
  useEffect(() => {
    if (auth !== "authenticated" || unitAccount) return; // HQ system status; not for store accounts
    let alive = true;
    const load = () => api.get<SystemStatus>("/api/system").then((r) => alive && setS(r)).catch(() => {});
    void load();
    const iv = window.setInterval(load, 60_000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [auth, bucket, unitAccount]);
  return s;
}
