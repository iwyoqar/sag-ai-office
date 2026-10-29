// Backend state → what the 3D character does. Pure and deterministic: no random work simulation.
import type { AgentLifecycle, AgentStatus } from "@sag/shared";

export type PoseName =
  | "stand" | "walk" | "sitRelax" | "sitType" | "sitThink" | "sitTalk" | "sitBlocked"
  | "standWait" | "standError" | "celebrate";

/** desk = seated at own workstation; deskStand = standing beside it; meeting = seated at the meeting table */
export type Place = "desk" | "deskStand" | "meeting";

export interface Activity {
  place: Place;
  pose: PoseName;
}

export function activityFor(status: AgentStatus, lifecycle: AgentLifecycle): Activity {
  if (lifecycle !== "ACTIVE") return { place: "desk", pose: "sitRelax" };
  switch (status) {
    case "WORKING": return { place: "desk", pose: "sitType" };
    case "THINKING": return { place: "desk", pose: "sitThink" };
    case "COMMUNICATING": return { place: "meeting", pose: "sitTalk" };
    case "WAITING_APPROVAL": return { place: "deskStand", pose: "standWait" };
    case "BLOCKED": return { place: "desk", pose: "sitBlocked" };
    case "ERROR": return { place: "deskStand", pose: "standError" };
    case "COMPLETED": return { place: "deskStand", pose: "celebrate" };
    case "IDLE": return { place: "desk", pose: "sitRelax" };
  }
}

export const isSeated = (p: PoseName) => p.startsWith("sit");

/**
 * Human employees: activity from real data only (task statuses + last activity). No meetings are invented -
 * there is no calendar data for people yet. "away" = no activity for 30 min (the desk stays empty).
 */
export type HumanPresence = "available" | "working" | "reviewing" | "blocked" | "away";
export function activityForPresence(state: HumanPresence): Activity | null {
  switch (state) {
    case "working": return { place: "desk", pose: "sitType" };
    case "reviewing": return { place: "desk", pose: "sitThink" };
    case "blocked": return { place: "desk", pose: "sitBlocked" };
    case "available": return { place: "desk", pose: "sitRelax" };
    case "away": return null;
  }
}
