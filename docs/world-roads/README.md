# Road network, logistics traffic and world navigation (2026-10-30)

Not committed. Screenshots are in this folder. The built-in browser can't record video, so `08-motion-1..3` are
three frames of a truck taking a junction, a fraction of a second apart.

| Shot | What it shows |
|---|---|
| [00-before-overview](00-before-overview.jpg) | Before: loose region grid, roads ending at the M37 |
| [01-overview](01-overview.jpg) | After: one connected world. The company ring around it comes from the other session (perimeter). |
| [02-compact-district](02-compact-district.jpg) | Compact store rows: fronts on one street, loading yards on the next |
| [03-roundabout-link](03-roundabout-link.jpg) | M37 roundabout at the campus entrance, the link road into the district, vans |
| [04-medium-truck](04-medium-truck.jpg) | Medium truck: SAG-blue cab, branded box |
| [05-large-truck-roundabout](05-large-truck-roundabout.jpg) | Large three-axle box truck taking the roundabout |
| [06-semi-to-gate](06-semi-to-gate.jpg) | Semi-trailer heading through the factory gate |
| [07-click-select-store](07-click-select-store.jpg) | A click still selects and opens a store, at the same fixed angle |
| [08-motion-1..3](08-motion-1.jpg) | A truck following its route through a junction |

## Road network (Phase A): `scene/world/roads.ts`, `network.ts`, `roadRender.ts`
- **One graph** for the whole world: 69 nodes, 77 edges, 36 named destinations.
  - It covers the M37, the campus roads, the industrial ring and every district street.
  - The district streets are generated from the district plan, and drawn from the same graph.
  - The campus roads trace the surfaces that `site.ts` draws from `layout.ts`.
- **Checked by tests**, so vehicles can't leave the road or cross a building:
  - one connected component;
  - zero stray dead ends (every dead end is a dock);
  - every destination reachable: **1,260 valid routes** (36 × 35);
  - every lane path of 150+ sampled routes stays on the road surface and clear of every building, planted island and
    parked row.
- **Junctions:**
  - a roundabout on the M37 at the campus entrance (kerbed, planted island, lane ring, give-way markings);
  - T and X junctions with zebra crossings in the district.
  - Turns use smooth lane curves, and docks at dead ends use U-turn loops.
- **Truck access:** road 2 now runs past the warehouse to a new east service road and on to the M37. Heavy trucks
  reach the factories without crossing the HQ forecourt; their route costs prefer industrial roads.
- **Loading zones:**
  - factory roller doors keep yellow bays and bumpers; the static trucks are gone, since live traffic serves the docks;
  - each store has a stop on its rear street, opposite its yard gate;
  - each store has a driveway cut and a dropped kerb to its front street.
- **M37:** the sidewalks open where roads cross, and trees and lamps leave those gaps clear.

## Camera (Phase B): `SceneController.ts`, `NetworkScene.ts`
- Outside the office the tilt is fixed at 54° from vertical.
  - Rotation only in 90° steps (Q / E), animated.
  - Zoom limits: 40–950 m on the campus, 20–950 m when focused on a building or store.
  - The view target is kept inside the developed world.
- **Mouse:** left drag pans over the ground (with damping); right drag also pans.
- **Wheel:** smooth zoom that eases in, toward the point under the cursor.
- **Keys:** WASD and the arrow keys pan, faster when zoomed out; they are ignored while typing in a field.
- **Click:** selects a building or store and frames it smoothly at the same fixed angle, as before. A drag of more
  than 6 px never selects.
- **Double-click:** on open ground it glides there. On a building or store the click already frames it.
- **The office** (floors, diorama) keeps its own orbit camera.
- **Store accounts' view:** same fixed tilt and left-drag pan; its wheel uses OrbitControls' zoom toward the cursor.
- **Verified in the browser:** after a drag the target moved about 22 m, with the tilt still 54° and the distance unchanged;
  wheel zoom eased smoothly; a click opened "Sag liftzavod".

## Compact layout (Phase C): `network/districtLayout.ts`
- **Rows:** up to 6 stores side by side, packed region by region.
  - A region never splits unless it is bigger than a row.
  - Regions are blocks separated by cross streets.
- **Shared streets:** every store faces the street below its row; its loading yard faces the street above, which is
  the next row's shop frontage.
  - Spacing: 38 m per store, 52 m per row.
  - About 3,480 m² per store, against about 5,180 m² before: 33 % less land.
- **Data unchanged:** unit ids, regions and ownership; only the visual coordinates moved. New stores are placed
  automatically.
- **Tests:** 23 stores, no overlaps, one region per block.

## Logistics traffic (Phase D): `scene/world/vehicles.ts`, `traffic.ts`
- **Vehicle types**, all built from extruded side profiles (no plain cubes):
  - **Small van** (5.9 m): white or blue body, sloped windscreen, SAG logo and band on the flanks.
  - **Medium truck** (7.4 m): cab-over, branded box.
  - **Large box truck** (10.2 m): three axles.
  - **Semi** (6.2 m tractor + 13.6 m trailer): roof fairing; the articulated trailer follows the path.
  - All have wheels with hubs, head and tail lights, bumpers, mirrors and a contact shadow.
  - Liveries: SAG blue, white or graphite.
  - Cargo bodies carry canvas textures: logo, blue band, "HOME DESIGN · GILAMLAR", branded rear doors.
- **Trips** are meaningful legs:
  - factory docks → main warehouse;
  - M37 → factories (inbound raw material);
  - warehouse → M37 (outbound freight);
  - warehouse → stores and back;
  - HQ ↔ stores (vans);
  - store → store.
  - Vehicles dwell 3–8 s at each stop, then take the next leg from where they are.
- **Routing:** Dijkstra with per-kind road costs, cached per destination pair. Lane paths are cached per route, so
  nothing is path-planned in the frame loop.
- **Behaviour:**
  - smooth acceleration and braking, road-class speed limits;
  - car-following through a spatial hash, with trailers included;
  - junction reservations: one vehicle per junction box, two on the roundabout, and only when the exit has room;
  - a stuck watchdog that retires a vehicle after 30 s without moving.
  - In all test runs **0 vehicles were retired**.
- **Traffic manager** (`TrafficManager.configure`):
  - min/max vehicle counts and a density between them;
  - a spawn interval, one vehicle at a time from a depot;
  - the vehicle-kind mix, and pause/resume;
  - it pre-warms the network with vehicles already spread along their routes.
  - Defaults: 10–40 vehicles, density 0.55, giving about 27 on the road.
- **Drawing:** one InstancedMesh per vehicle part, about 45 draw calls for the whole fleet at any size. Vehicles cast
  no real shadow (their contact shadow is a decal), so the campus shadow map is still not redrawn while they move.

## World boundary (Phase E): `scene/world/boundary.ts`, `campus/site.ts`
- **Removed:** the random residential filler and the endless grass disc.
- **Ground:** a grass plate sized to the developed world. The rectangle follows the district plan and the perimeter
  ring, so it grows with the layout.
- **Haze:** a ring fades into the horizon colour 40–210 m beyond the edge. The M37 runs out into it, and freight
  enters and leaves there.
- **Furniture:** M37 trees and lamps stop at the world edge.
- **Data unchanged:** no business data is touched; new districts widen the plate.

## Performance (Phase F)
1440×900, DPR 1, median of 5×10 frames. Each frame is a traffic update plus a full render. This machine was also
running other sessions, so the numbers are noisy.

| View | ms / frame | Draw calls | Triangles |
|---|---|---|---|
| Campus overview, everything on | 20–25 | 1,037 | 668k |
| District overview | 29 | 987 | 665k |
| HQ wide | 20 | 254 | 507k |
| Roundabout close | 23 | 278 | 529k |
| Store close | 20 | 327 | 513k |

- **Roads and traffic** add about 1 ms to the overview (18.3 → 17.2 ms with them hidden).
- **Traffic update** costs 0.05 ms for 27 vehicles.
  - Stress run: 83 vehicles at 0.24 ms per update. That is far below the 200 asked for, because spawning is throttled
    at the depots on purpose.
- **Rendering:** the app renders continuously only while traffic is on screen. The office interior still renders on
  demand.

## Tests
- `apps/web/test/roads.test.ts`: 7 tests covering layout, connectivity, routes, and on-road/no-collision paths for
  all vehicle kinds.
- All 52 web tests pass, tsc is clean, and the production build succeeds.

## Limitations
- **Views:** road 1 and road 2 run between 11–13 m factory halls, so from the fixed isometric angle trucks there are
  mostly hidden by the roofs.
- **Rerouting:** vehicles don't re-route around congestion. A blocked vehicle waits, then the 30 s watchdog retires it.
- **Store-account view:** it shows the district streets but runs no traffic, because the warehouse is not in that view.
- **Roundabout size:** it fits within the M37's 18 m width, so long trucks take it tightly.
- **Rotation:** only in 90° steps (Q / E). There is no free rotation, by design.
- **Shared files:** the other session's perimeter wiring lines sit in shared files (`CampusScene.ts`, `layout.ts`,
  `site.ts`, `network.ts`, `boundary.ts`) and in `test/perimeter.test.ts`. It committed its own standalone files as
  `f0fcc64`, locally and not pushed, and asked that those lines go in with this work's commit.
