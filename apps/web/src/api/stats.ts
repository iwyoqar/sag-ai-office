import { useEffect, useState } from "react";
import type { DeptStats, StatsRange } from "@sag/shared";
import { api } from "./client";
import { useOffice } from "./office";

export interface StatsResponse {
  range: { from: string; to: string; kind: StatsRange; timezone: string };
  departments: DeptStats[];
}

/** Department stats from /api/stats; refetched (throttled) when realtime events arrive. */
export function useStats(range: StatsRange, from?: string, to?: string) {
  const { tick, auth } = useOffice();
  const [data, setData] = useState<StatsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bucket, setBucket] = useState(0);

  // At most one refetch per second for bursts of events.
  useEffect(() => {
    const t = window.setTimeout(() => setBucket(tick), 1000);
    return () => window.clearTimeout(t);
  }, [tick]);

  useEffect(() => {
    if (auth !== "authenticated") return;
    if (range === "custom" && (!from || !to)) return;
    let alive = true;
    const qs = new URLSearchParams({ range, ...(range === "custom" ? { from: from!, to: to! } : {}) });
    api
      .get<StatsResponse>(`/api/stats?${qs}`)
      .then((r) => alive && (setData(r), setError(null)))
      .catch((e) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [range, from, to, bucket, auth]);

  return { data, error };
}

export function sumStats(list: DeptStats[]): Omit<DeptStats, "departmentId"> {
  const durations = list.filter((s) => s.avgMinutes !== null && s.completed > 0);
  const doneWithTime = durations.reduce((n, s) => n + s.completed, 0);
  return {
    agents: list.reduce((n, s) => n + s.agents, 0),
    active: list.reduce((n, s) => n + s.active, 0),
    idle: list.reduce((n, s) => n + s.idle, 0),
    inProgress: list.reduce((n, s) => n + s.inProgress, 0),
    queued: list.reduce((n, s) => n + s.queued, 0),
    waitingApproval: list.reduce((n, s) => n + s.waitingApproval, 0),
    completed: list.reduce((n, s) => n + s.completed, 0),
    errors: list.reduce((n, s) => n + s.errors, 0),
    // Weighted by completed count, so a busy department counts more than an idle one.
    avgMinutes: doneWithTime ? Math.round((durations.reduce((n, s) => n + s.avgMinutes! * s.completed, 0) / doneWithTime) * 10) / 10 : null,
    tokens: list.reduce((n, s) => n + s.tokens, 0),
    costUsd: Math.round(list.reduce((n, s) => n + s.costUsd, 0) * 10000) / 10000,
  };
}
