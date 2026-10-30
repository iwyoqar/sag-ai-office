// The world's road graph: campus roads (traced on the surfaces site.ts already draws, see campus/layout.ts), the M37
// with a roundabout at the campus entrance, the industrial ring (road 2 → east service road → M37), and the store
// district streets generated from the district plan. Named destinations are the logistics stops.
import type { DistrictPlan } from "../network/districtLayout";
import { lookFor } from "../network/storeLooks";
import { RoadGraph } from "./roads";

/** campus entrance roundabout on the M37 (centre, lane ring radius) */
export const ROUNDABOUT = { x: 54, z: 75, ring: 5, outer: 9.4, island: 3.6 };
/** east industrial service road: x span (drawn as a campus road, see layout.ts ROADS "east") */
export const EAST_ROAD_X = 484;

export function buildWorldGraph(plan: DistrictPlan | null): RoadGraph {
  const g = new RoadGraph();
  const R = ROUNDABOUT;

  // M37: west edge of the world → roundabout → east service road junction → east edge
  g.node(-330, 75, { dest: "m37-west" });
  g.node(900, 75, { dest: "m37-east" });
  g.node(R.x, R.z, { ring: R.ring });
  g.chain([[-330, 75], [R.x, R.z], [EAST_ROAD_X, 75], [900, 75]], "highway", 18, 4.5);

  // campus access road into the front parking courtyard, its drive aisle to the HQ, and the gate lane to the yard
  g.chain([[R.x, R.z], [54, 46], [47, 27]], "main", 12, 3);
  g.node(-12, 27, { dest: "hq" });
  g.chain([[47, 27], [-12, 27]], "service", 14, 3.5);
  // through the green gate (10 m wide) to a yard junction well clear of the wall, so turns happen in the open yard
  g.chain([[47, 27], [47, -12]], "service", 10, 1.6);
  // yard → road 1 (courtyard road between Factory A and B) → main warehouse loading door at its east end
  g.chain([[47, -12], [63, -7], [70, -2]], "service", 6, 1.2); // the 6 m gap between the gate wall and the admin block
  g.node(440, -2, { dest: "warehouse" });
  g.chain([[70, -2], [440, -2]], "industrial", 16, 4);
  // yard → passage gate → road 2 (behind Factory B, in front of Factory C) → east service road → M37
  g.chain([[47, -12], [47, -68]], "service", 10, 2);
  g.chain([[47, -68], [70, -68]], "service", 8, 1.6); // centred on the 8 m passage gate (z −72…−64)
  g.chain([[70, -68], [90, -69], [EAST_ROAD_X, -69], [EAST_ROAD_X, 75]], "industrial", 16, 3.5);

  // loading docks along the courtyard roads (roller doors in layout.ts)
  [122, 192, 312].forEach((x, i) => g.splitAt(x, -2, { dest: `factory-a:${i + 1}` }));
  [162, 282, 382].forEach((x, i) => g.splitAt(x, -2, { dest: `factory-b:${i + 1}` }));
  [132, 262, 382].forEach((x, i) => g.splitAt(x, -69, { dest: `factory-c:${i + 1}` }));

  if (plan) addDistrict(g, plan);
  return g;
}

/** District streets from the plan, joined to the roundabout by the link road, with a loading stop behind every store. */
function addDistrict(g: RoadGraph, plan: DistrictPlan) {
  const w = plan.cfg.street;
  const hs = plan.hStreets, vs = plan.vStreets;
  // split every street at every crossing with another street (T and X junctions), then chain the pieces
  for (const h of hs) {
    const xs = new Set<number>([h.from, h.to]);
    for (const v of vs) if (v.at >= h.from - 0.1 && v.at <= h.to + 0.1 && h.at >= v.from - 0.1 && h.at <= v.to + 0.1) xs.add(v.at);
    const sorted = [...xs].sort((a, b) => a - b);
    g.chain(sorted.map((x) => [x, h.at] as [number, number]), "street", w, w / 4, true);
  }
  for (const v of vs) {
    const zs = new Set<number>([v.from, v.to]);
    for (const h of hs) if (h.at >= v.from - 0.1 && h.at <= v.to + 0.1 && v.at >= h.from - 0.1 && v.at <= h.to + 0.1) zs.add(h.at);
    const sorted = [...zs].sort((a, b) => a - b);
    g.chain(sorted.map((z) => [v.at, z] as [number, number]), "street", w, w / 4, true);
  }
  // link road: roundabout → top street of the district (a T junction)
  const top = hs[0];
  const linkX = Math.min(Math.max(ROUNDABOUT.x, top.from + 10), top.to - 10);
  const t = g.splitAt(linkX, top.at);
  g.edge(g.node(ROUNDABOUT.x, ROUNDABOUT.z), t, "main", 12, 3, true);
  // a stop on each store's delivery street, opposite its loading-yard gate
  for (const s of plan.stores) {
    const rear = plan.rearStreetZ[s.row];
    // storeLot.ts / storeLooks.ts put the dock door and the yard gate a quarter of the building width right of centre
    g.splitAt(s.cx + lookFor(s.unit.name, s.unit.isHeadOffice).w / 4, rear, { dest: `store:${s.unit.id}` });
  }
}
