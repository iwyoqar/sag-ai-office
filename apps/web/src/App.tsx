import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { SceneController, webglAvailable } from "./scene/SceneController";
import type { CampusBuildingInfo } from "./scene/campus/CampusScene";
import { BUILDINGS } from "./scene/campus/layout";
import { initialView, viewReducer, type ViewState } from "./viewState";
import { useOffice } from "./api/office";
import { useStats } from "./api/stats";
import { useSystem } from "./api/system";
import { TaskPanel } from "./ui/TaskPanel";
import { TaskDetail } from "./ui/TaskDetail";
import { BrainPanel } from "./ui/BrainPanel";
import { CalendarPanel } from "./ui/CalendarPanel";
import { AccountDialog } from "./ui/AccountDialog";
import { PeoplePanel } from "./ui/people/PeoplePanel";
import { MarketplacePanel } from "./ui/marketplace/MarketplacePanel";
import { WorkforcePanel } from "./ui/WorkforcePanel";
import { EmployeeProfile } from "./ui/people/Employees";
import { NewWork, WorkDetail } from "./ui/people/Work";
import { TopBar } from "./ui/TopBar";
import { FloorRail } from "./ui/FloorRail";
import { FloorPanel } from "./ui/FloorPanel";
import { CompanyPanel } from "./ui/CompanyPanel";
import { AgentProfile } from "./ui/AgentProfile";
import { HoverCard, AgentTip } from "./ui/HoverCard";
import { BuildingPanel, BuildingTip, CampusBuildings } from "./ui/CampusPanels";
import { Loader } from "./ui/Loader";
import { Login } from "./ui/Login";
import { FallbackBuilding } from "./ui/FallbackBuilding";
import { NetworkView, UnitPanel, occupantsOf } from "./ui/NetworkView";
import { api } from "./api/client";
import type { NetworkDto, UnitCardDto } from "@sag/shared";
import { CreateBranchModal } from "./ui/CreateBranchModal";

const BUILDING_IDS = BUILDINGS.map((b) => b.id);
const LABELS_KEY = "sag.campusLabels";

function readLabelsPref() {
  try {
    return localStorage.getItem(LABELS_KEY) !== "0";
  } catch {
    return true;
  }
}

export function App() {
  const { auth, office, error, lastEvent, unitAccount, user } = useOffice();
  const floorIds = useMemo(() => office?.floors.map((f) => f.id) ?? [], [office]);
  const reducer = useMemo(() => viewReducer(floorIds, BUILDING_IDS), [floorIds]);
  const [view, dispatch] = useReducer(reducer, initialView);
  const [has3d] = useState(webglAvailable);
  const [progress, setProgress] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState({ x: 0, y: 0 });
  const [agentTip, setAgentTip] = useState<{ id: string; x: number; y: number } | null>(null);
  const [buildingTip, setBuildingTip] = useState<{ info: CampusBuildingInfo; x: number; y: number } | null>(null);
  const [labels, setLabels] = useState(readLabelsPref);
  const host = useRef<HTMLDivElement>(null);
  const ctrl = useRef<SceneController | null>(null);
  /** What the 3D scene currently shows, so view changes only trigger the transitions they need. */
  const applied = useRef<Pick<ViewState, "mode" | "floorId" | "buildingId">>({ mode: "intro", floorId: null, buildingId: null });
  const today = useStats("today");
  const system = useSystem();
  const [tasksOpen, setTasksOpen] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [brainOpen, setBrainOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [marketplaceOpen, setMarketplaceOpen] = useState(false);
  const [workforceOpen, setWorkforceOpen] = useState(false);
  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [workId, setWorkId] = useState<string | null>(null);
  const [newWork, setNewWork] = useState<{ assigneeId?: string } | null>(null);
  /** a store of the network opened on the campus */
  const [storeId, setStoreId] = useState<string | null>(null);
  /** the store network as loaded (regions for the new-branch form) and the free map slot right-clicked for it */
  const [network, setNetwork] = useState<NetworkDto | null>(null);
  const [placeSlot, setPlaceSlot] = useState<{ gridX: number; gridZ: number } | null>(null);
  // placing new stores on the map is structure work: HQ platform admins (the server enforces the same rule)
  const canPlace = !!user?.roles.includes("admin") && (user.homeUnitId ?? "hq") === "hq";

  useEffect(() => {
    if (!has3d || !host.current) {
      dispatch({ type: "introDone" });
      return;
    }
    const c = new SceneController(host.current, {
      onProgress: setProgress,
      onLoaded: () => {},
      onError: (m) => setLoadError(m),
      onIntroDone: () => {
        applied.current = { mode: "campus", floorId: null, buildingId: null };
        dispatch({ type: "introDone" });
      },
      onHover: (floorId, x, y) => {
        dispatch({ type: "hover", floorId });
        setHoverPos({ x, y });
      },
      onSelectFloor: (floorId) => dispatch({ type: "selectFloor", floorId }),
      onSelectAgent: (agentId) => dispatch({ type: "selectAgent", agentId }),
      onSelectEmployee: (id) => setEmployeeId(id),
      onHoverAgent: (id, x, y) => setAgentTip(id ? { id, x, y } : null),
      onHoverBuilding: (info, x, y) => setBuildingTip(info ? { info, x, y } : null),
      onSelectBuilding: (id) => dispatch({ type: "selectBuilding", buildingId: id }),
      onSelectStore: (id) => setStoreId(id),
      onPlaceRequest: (slot) => setPlaceSlot(slot),
    });
    ctrl.current = c;
    c.setLabelsVisible(readLabelsPref());
    if (import.meta.env.DEV) (window as unknown as { __sag: SceneController }).__sag = c;
    return () => {
      c.dispose();
      ctrl.current = null;
    };
  }, [has3d]);

  // Backend snapshot → 3D (statuses update in place; roster changes rebuild a floor).
  useEffect(() => {
    if (office) ctrl.current?.setOffice(office);
  }, [office]);

  // Drive the 3D scene from the view state.
  useEffect(() => {
    const c = ctrl.current;
    if (!c || view.mode === "intro") return;
    const prev = applied.current;
    if (prev.mode === view.mode && prev.floorId === view.floorId && prev.buildingId === view.buildingId) return;
    applied.current = { mode: view.mode, floorId: view.floorId, buildingId: view.buildingId };
    setBuildingTip(null);
    if (view.mode === "floor" && view.floorId) void c.openFloor(view.floorId);
    else if (view.mode === "overview") void c.showOffice();
    else if (view.mode === "campus") {
      if (storesNext.current) void c.showStores();
      else void c.showCampus();
      storesNext.current = false;
    }
    else if (view.mode === "building" && view.buildingId) void c.focusBuilding(view.buildingId);
  }, [view.mode, view.floorId, view.buildingId]);

  useEffect(() => ctrl.current?.selectAgent(view.agentId), [view.agentId]);

  // The SAG store network stands beside the campus (HQ accounts; store accounts get their own store view).
  useEffect(() => {
    if (auth !== "authenticated" || unitAccount || !office) return;
    let alive = true;
    api.get<{ network: NetworkDto }>("/api/units").then((r) => {
      if (!alive) return;
      setNetwork(r.network);
      ctrl.current?.setNetwork(r.network);
    }).catch(() => {});
    return () => {
      alive = false;
    };
  }, [auth, unitAccount, !!office]);
  useEffect(() => ctrl.current?.setPlacementEnabled(canPlace), [canPlace]);
  /** a branch created on the map: into the scene (just that store and its streets) and into the network list */
  const onBranchCreated = useCallback((unit: UnitCardDto) => {
    ctrl.current?.addPlacedStore(unit);
    setNetwork((n) => n && {
      ...n,
      regions: n.regions.map((r) => (r.id === unit.regionId ? { ...r, units: [...r.units, unit] } : r)),
    });
    setPlaceSlot(null);
  }, []);
  useEffect(() => {
    if (storeId) void ctrl.current?.focusStore(storeId);
    else ctrl.current?.closeStore();
  }, [storeId]);
  // any other navigation closes the open store
  useEffect(() => setStoreId(null), [view.mode, view.floorId, view.buildingId]);

  // Agent→agent handoffs from the backend stay visible in 3D for a short while.
  const links = useRef<{ from: string; to: string; at: number }[]>([]);
  useEffect(() => {
    const push = () => {
      const cut = Date.now() - 20_000;
      links.current = links.current.filter((l) => l.at > cut);
      ctrl.current?.showLinks(links.current.map((l) => [l.from, l.to] as [string, string]));
    };
    if (lastEvent?.type === "agent.message" && typeof lastEvent.data.from === "string" && typeof lastEvent.data.to === "string")
      links.current.push({ from: lastEvent.data.from, to: lastEvent.data.to, at: Date.now() });
    push();
    const t = window.setInterval(push, 5000);
    return () => window.clearInterval(t);
  }, [lastEvent]);

  useEffect(() => {
    ctrl.current?.setLabelsVisible(labels);
    try {
      localStorage.setItem(LABELS_KEY, labels ? "1" : "0");
    } catch {
      /* per-viewer convenience only */
    }
  }, [labels]);

  // Logging out returns to the campus.
  useEffect(() => {
    if (auth === "anonymous") dispatch({ type: "showCampus" });
  }, [auth]);

  const back = useCallback(() => dispatch({ type: "back" }), []);
  /** "Do'konlar": one flight to the store district (from the campus, or via the campus transition from elsewhere) */
  const storesNext = useRef(false);
  const showStores = () => {
    setStoreId(null);
    if (view.mode === "campus") void ctrl.current?.showStores();
    else {
      storesNext.current = true;
      dispatch({ type: "showCampus" });
    }
  };
  const taskIdRef = useRef<string | null>(null);
  taskIdRef.current = taskId;
  const brainRef = useRef(false);
  brainRef.current = brainOpen;
  const calRef = useRef(false);
  calRef.current = calendarOpen;
  const storeRef = useRef<string | null>(null);
  storeRef.current = storeId;
  /** closing a store (✕ / Esc) flies back out to the store district */
  const leaveStore = () => {
    setStoreId(null);
    void ctrl.current?.showStores();
  };
  const leaveStoreRef = useRef(leaveStore);
  leaveStoreRef.current = leaveStore;
  const layers = useRef({ work: false, emp: false, people: false, newWork: false });
  layers.current = { work: !!workId, emp: !!employeeId, people: peopleOpen, newWork: !!newWork };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // close the topmost layer first
      if (storeRef.current) leaveStoreRef.current();
      else if (layers.current.newWork) setNewWork(null);
      else if (layers.current.work) setWorkId(null);
      else if (layers.current.emp) setEmployeeId(null);
      else if (taskIdRef.current) setTaskId(null);
      else if (layers.current.people) setPeopleOpen(false);
      else if (brainRef.current) setBrainOpen(false);
      else if (calRef.current) setCalendarOpen(false);
      else back();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [back]);

  const floor = view.floorId ? office?.floors.find((f) => f.id === view.floorId) : undefined;
  const hoverFloor = view.hoveredFloorId ? office?.floors.find((f) => f.id === view.hoveredFloorId) : undefined;
  const focused = view.buildingId ? BUILDINGS.find((b) => b.id === view.buildingId) : undefined;
  const select = (floorId: string) => dispatch({ type: "selectFloor", floorId });
  const selectBuilding = (id: string) => dispatch({ type: "selectBuilding", buildingId: id });
  const ready = view.mode !== "intro" && auth === "authenticated" && !!office;
  const inCampus = view.mode === "campus" || view.mode === "building";

  return (
    <div className={`app mode-${view.mode}`}>
      {has3d ? <div ref={host} className="stage" data-testid="stage" /> : ready && <FallbackBuilding onSelect={select} selected={view.floorId} />}

      {has3d && view.mode === "intro" && (
        <Loader progress={progress} error={loadError} onSkip={() => ctrl.current?.skipIntro()} />
      )}

      <TopBar
        floor={floor}
        building={focused?.name}
        inOffice={view.mode === "overview" || view.mode === "floor"}
        onCampus={view.mode !== "campus" && view.mode !== "intro" ? () => dispatch({ type: "showCampus" }) : undefined}
        onOffice={view.mode === "floor" ? () => dispatch({ type: "showOffice" }) : undefined}
        onTasks={ready ? () => setTasksOpen((o) => !o) : undefined}
        tasksOpen={tasksOpen}
        onBrain={ready ? () => setBrainOpen(true) : undefined}
        onCalendar={ready ? () => setCalendarOpen(true) : undefined}
        onAccount={() => setAccountOpen(true)}
        onPeople={ready ? () => setPeopleOpen(true) : undefined}
        onMarketplace={ready ? () => setMarketplaceOpen(true) : undefined}
        onWorkforce={ready ? () => setWorkforceOpen(true) : undefined}
        onNetwork={ready ? showStores : undefined}
        onOpenWork={ready ? setWorkId : undefined}
        system={ready ? system : null}
      />

      {view.mode !== "intro" && auth === "anonymous" && <Login />}
      {view.mode !== "intro" && auth === "authenticated" && unitAccount && <NetworkView unitAccount />}
      {view.mode !== "intro" && auth === "authenticated" && !office && !unitAccount && (
        <div className="center-note">{error ? `Ma'lumot yuklanmadi: ${error}` : "Ofis ma'lumotlari yuklanmoqda…"}</div>
      )}

      {ready && (
        <>
          {!storeId && <FloorRail current={view.floorId} hovered={view.hoveredFloorId} onSelect={select} />}
          {storeId ? (
            <UnitPanel
              unitId={storeId}
              onClose={leaveStore}
              onLoaded={(o) => ctrl.current?.setStoreOccupants(o.unit.id, occupantsOf(o))}
            />
          ) : view.mode === "floor" && floor ? (
            <FloorPanel floor={floor} onBack={back} onAgent={(id) => dispatch({ type: "selectAgent", agentId: id })} selectedAgent={view.agentId} />
          ) : view.mode === "building" && focused ? (
            <BuildingPanel
              info={{ id: focused.id, name: focused.name, category: focused.category, interaction: focused.interaction, info: focused.info }}
              onBack={back}
              onEnterOffice={() => dispatch({ type: "showOffice" })}
            />
          ) : (
            <CompanyPanel onSelect={select} stats={today.data} onBack={view.mode === "overview" ? back : undefined}>
              {view.mode === "campus" && (
                <CampusBuildings onSelect={selectBuilding} labels={labels} onToggleLabels={() => setLabels((l) => !l)} />
              )}
            </CompanyPanel>
          )}
        </>
      )}

      {ready && hoverFloor && view.mode === "overview" && <HoverCard floor={hoverFloor} x={hoverPos.x} y={hoverPos.y} stats={today.data} />}
      {ready && inCampus && !storeId && buildingTip && <BuildingTip info={buildingTip.info} x={buildingTip.x} y={buildingTip.y} />}
      {ready && agentTip && view.mode === "floor" && !view.agentId && <AgentTip agentId={agentTip.id} x={agentTip.x} y={agentTip.y} />}
      {ready && tasksOpen && <TaskPanel onClose={() => setTasksOpen(false)} onOpen={setTaskId} system={system} />}
      {ready && brainOpen && <BrainPanel onClose={() => setBrainOpen(false)} />}
      {accountOpen && auth === "authenticated" && <AccountDialog onClose={() => setAccountOpen(false)} />}
      {placeSlot && network && canPlace && (
        <CreateBranchModal slot={placeSlot} network={network} onClose={() => setPlaceSlot(null)} onCreated={onBranchCreated} />
      )}
      {ready && calendarOpen && <CalendarPanel onClose={() => setCalendarOpen(false)} onOpenTask={setTaskId} />}
      {ready && taskId && <TaskDetail taskId={taskId} onClose={() => setTaskId(null)} onOpen={setTaskId} />}
      {ready && marketplaceOpen && <MarketplacePanel onClose={() => setMarketplaceOpen(false)} />}
      {ready && workforceOpen && <WorkforcePanel onClose={() => setWorkforceOpen(false)} onOpenTask={(id) => { setWorkforceOpen(false); setTaskId(id); }} />}
      {ready && peopleOpen && (
        <PeoplePanel onClose={() => setPeopleOpen(false)} onOpenEmployee={setEmployeeId} onOpenTask={setWorkId} onNewTask={() => setNewWork({})} />
      )}
      {ready && employeeId && (
        <EmployeeProfile id={employeeId} onClose={() => setEmployeeId(null)} onOpenTask={setWorkId} onAssign={(id) => setNewWork({ assigneeId: id })} />
      )}
      {ready && workId && <WorkDetail id={workId} onClose={() => setWorkId(null)} onOpen={setWorkId} />}
      {ready && newWork && (
        <NewWork assigneeId={newWork.assigneeId} onClose={() => setNewWork(null)} onCreated={(id) => { setNewWork(null); setWorkId(id); }} />
      )}
      {ready && view.agentId && <AgentProfile agentId={view.agentId} onClose={() => dispatch({ type: "selectAgent", agentId: null })} />}
    </div>
  );
}

