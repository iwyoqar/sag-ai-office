import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentDto, ConnectorDto, DepartmentDto, FloorDto, OfficeEvent, Permission, UserDto } from "@sag/shared";
import { api, ApiError } from "./client";

export interface Office {
  floors: FloorDto[];
  departments: Record<string, DepartmentDto>;
  agents: AgentDto[];
  connectors: ConnectorDto[];
}

type AuthState = "checking" | "anonymous" | "authenticated";

interface OfficeCtx {
  auth: AuthState;
  user: UserDto | null;
  office: Office | null;
  error: string | null;
  /** SSE stream is open. */
  live: boolean;
  /** Increments on every realtime event, so views can refetch what they show. */
  tick: number;
  lastEvent: OfficeEvent | null;
  can: (p: Permission) => boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<OfficeCtx | null>(null);

export function useOffice(): OfficeCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useOffice outside OfficeProvider");
  return c;
}

const EVENT_TYPES = [
  "task.created", "task.updated", "task.status", "task.progress", "agent.updated", "agent.status",
  "agent.paused", "agent.resumed", "approval.requested", "connector.activity", "agent.message",
];

export function OfficeProvider({ children }: { children: ReactNode }) {
  const [auth, setAuth] = useState<AuthState>("checking");
  const [user, setUser] = useState<UserDto | null>(null);
  const [office, setOffice] = useState<Office | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [tick, setTick] = useState(0);
  const [lastEvent, setLastEvent] = useState<OfficeEvent | null>(null);

  const load = useCallback(async () => {
    try {
      const [fl, ag, co] = await Promise.all([
        api.get<{ floors: FloorDto[]; departments: DepartmentDto[] }>("/api/floors"),
        api.get<{ agents: AgentDto[] }>("/api/agents"),
        api.get<{ connectors: ConnectorDto[] }>("/api/connectors"),
      ]);
      setOffice({
        floors: fl.floors,
        departments: Object.fromEntries(fl.departments.map((d) => [d.id, d])),
        agents: ag.agents,
        connectors: co.connectors,
      });
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAuth("anonymous");
        setUser(null);
      } else setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshAgents = useCallback(async () => {
    try {
      const ag = await api.get<{ agents: AgentDto[] }>("/api/agents");
      setOffice((o) => (o ? { ...o, agents: ag.agents } : o));
    } catch {
      /* next event or reconnect will retry */
    }
  }, []);

  useEffect(() => {
    api
      .get<{ user: UserDto }>("/api/auth/me")
      .then((r) => {
        setUser(r.user);
        setAuth("authenticated");
      })
      .catch((e) => {
        setAuth("anonymous");
        if (!(e instanceof ApiError && e.status === 401)) setError(e.message);
      });
  }, []);

  useEffect(() => {
    if (auth === "authenticated") void load();
  }, [auth, load]);

  // Realtime: EventSource reconnects by itself and sends Last-Event-ID, so missed events are replayed.
  // A proxy can keep a dead stream open without erroring, so a watchdog reopens it when even the
  // server's 20 s heartbeat stops arriving.
  const pending = useRef<number | null>(null);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (auth !== "authenticated") return;
    const es = new EventSource("/api/events");
    let lastSeen = Date.now();
    const seen = () => (lastSeen = Date.now());
    es.addEventListener("ping", seen);
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastSeen > 45_000) {
        setLive(false);
        setGeneration((g) => g + 1);
      }
    }, 10_000);
    const onEvent = (msg: MessageEvent) => {
      seen();
      const ev = JSON.parse(msg.data) as OfficeEvent;
      setLastEvent(ev);
      setTick((t) => t + 1);
      // Coalesce bursts (e.g. bulk reassign) into one refetch.
      if (pending.current) window.clearTimeout(pending.current);
      pending.current = window.setTimeout(() => {
        pending.current = null;
        void (ev.type === "agent.updated" ? load() : refreshAgents());
      }, 250);
    };
    for (const t of EVENT_TYPES) es.addEventListener(t, onEvent);
    es.addEventListener("ready", () => {
      seen();
      setLive(true);
      // after any (re)connect: resync everything the views show
      setTick((t) => t + 1);
      void load();
    });
    es.onerror = () => setLive(false);
    return () => {
      window.clearInterval(watchdog);
      es.close();
      setLive(false);
    };
  }, [auth, load, refreshAgents, generation]);

  const value = useMemo<OfficeCtx>(
    () => ({
      auth, user, office, error, live, tick, lastEvent,
      can: (p) => !!user?.permissions.includes(p),
      login: async (username, password) => {
        const r = await api.post<{ user: UserDto }>("/api/auth/login", { username, password });
        setUser(r.user);
        setAuth("authenticated");
      },
      logout: async () => {
        await api.post("/api/auth/logout").catch(() => {});
        setUser(null);
        setOffice(null);
        setAuth("anonymous");
      },
      refresh: load,
    }),
    [auth, user, office, error, live, tick, lastEvent, load],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function floorOfDepartment(office: Office, depId: string): FloorDto | undefined {
  return office.floors.find((f) => f.departments.includes(depId));
}

export function agentsOfFloor(office: Office, floorId: string): AgentDto[] {
  const f = office.floors.find((x) => x.id === floorId);
  return f ? office.agents.filter((a) => f.departments.includes(a.departmentId)) : [];
}
