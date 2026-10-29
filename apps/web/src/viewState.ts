// UI navigation state for the 3D campus + office. Pure reducer so the flow is testable without WebGL.
//   intro → campus ⇄ building (factory inspect)
//              ↓ HQ
//           overview (office, floors) ⇄ floor ⇄ agent

export type Mode = "intro" | "campus" | "building" | "overview" | "floor";

export const HQ_ID = "hq";

export interface ViewState {
  mode: Mode;
  buildingId: string | null;
  floorId: string | null;
  hoveredFloorId: string | null;
  agentId: string | null;
}

export type ViewAction =
  | { type: "introDone" }
  | { type: "showCampus" }
  | { type: "showOffice" }
  | { type: "selectBuilding"; buildingId: string }
  | { type: "hover"; floorId: string | null }
  | { type: "selectFloor"; floorId: string }
  | { type: "selectAgent"; agentId: string | null }
  | { type: "back" };

export const initialView: ViewState = { mode: "intro", buildingId: null, floorId: null, hoveredFloorId: null, agentId: null };

const base = { buildingId: null, floorId: null, hoveredFloorId: null, agentId: null };

/** `floorIds` are the floors that exist (from the API); `buildingIds` the campus buildings. Unknown ids are ignored. */
export function viewReducer(floorIds: readonly string[], buildingIds: readonly string[] = []) {
  return (s: ViewState, a: ViewAction): ViewState => {
    switch (a.type) {
      case "introDone":
        return s.mode === "intro" ? { ...base, mode: "campus" } : s;
      case "showCampus":
        return s.mode === "intro" ? s : { ...base, mode: "campus" };
      case "showOffice":
        return s.mode === "intro" ? s : { ...base, mode: "overview" };
      case "selectBuilding":
        if (s.mode === "intro") return s;
        if (a.buildingId === HQ_ID) return { ...base, mode: "overview" };
        if (!buildingIds.includes(a.buildingId)) return s;
        return { ...base, mode: "building", buildingId: a.buildingId };
      case "hover":
        if (s.mode !== "overview") return s.hoveredFloorId ? { ...s, hoveredFloorId: null } : s;
        return s.hoveredFloorId === a.floorId ? s : { ...s, hoveredFloorId: a.floorId };
      case "selectFloor":
        if (!floorIds.includes(a.floorId)) return s;
        return { ...base, mode: "floor", floorId: a.floorId };
      case "selectAgent":
        if (s.mode !== "floor") return s;
        return { ...s, agentId: a.agentId };
      case "back":
        if (s.agentId) return { ...s, agentId: null };
        if (s.mode === "floor") return { ...base, mode: "overview" };
        if (s.mode === "overview" || s.mode === "building") return { ...base, mode: "campus" };
        return s;
    }
  };
}
