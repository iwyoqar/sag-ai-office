# SAG campus — layout and assumptions

Source of truth for positions/sizes: `apps/web/src/scene/campus/layout.ts`.
Everything here is **estimated** from the 7 ground photos and 2 satellite images supplied on 2026-10-29.
No survey data was available. The only known dimension is the office model itself (36 × 20 m footprint, from
`3d/build_sag_building.py`); the rest is scaled from it.

## Coordinate system

Same frame as the office GLB: metres, `+Y` up, `+Z` = office front. The office model stays at the origin, unchanged.

| Real world (satellite) | Scene |
|---|---|
| Office front faces south-east (parking, M37) | `+Z` |
| Complex runs north-east along M37 | `+X` |
| M37 road | along X at z = 66…84 |

## Evidence → decision

| Evidence | Decision |
|---|---|
| Satellite 1: one large rectangular complex, long side parallel to M37, roofs almost fully covered with solar panels | Halls x = 62…472, z = −132…58 (~410 × 190 m, aspect ≈ 2.2 : 1); solar rows on every factory roof |
| Satellite 2: office at the south corner, parking with white cars beside it | Office at origin; front lot (x −40…62, z 13…58) with ~120 bays |
| Photos 2–3: office (left), 2-storey stone annex with glass doors + dark canopy, stone wall with blue tile edge, SAG letters, green industrial gate, guard booth with brown roof, tall ribbed factory (right) | `annex`, `gatewall` (+ sign), `booth`, `factory-a` west facade facing the parking |
| Photo 1: long beige ribbed facade, single row of small windows, roof vents, seen across the parking | `factory-a`: 13 m, small windows at 6.4 m, 30 roof vents |
| Photos 4–5: internal road between two long halls, end building with stepped parapet, ribbon windows, central loading door, blue sign, yellow edge line, guard booth, roller doors, fire cabinets | `road-1` (16 m), `factory-c`, `endblock` (17 m + 3 m parapet), roller/personnel doors, red cabinets |
| Photo 6: wall with drive-through opening, blue tile coping, pipes | `passage` wall across the west end of `road-2` |
| Photo 7: single-storey building with large windows and benches on the courtyard road | `admin` (5.6 m) with office windows and a front overhang |

## Buildings (estimates)

| id | Name in UI | Footprint x × z (m) | Height (m) |
|---|---|---|---|
| hq | SAG Headquarters (existing model) | 38 × 25.6 | 24.8 (+ logo, antenna) |
| annex | Kirish bloki | 15.4 × 13 | 8.4 |
| gatewall | Asosiy darvoza | 28 × 5 | 6.2 |
| booth | Qo'riqlash posti | 2.8 × 2.8 | 2.6 + roof |
| factory-a | Factory Building A | 382 × 50 | 13 |
| admin | Ma'muriy blok | 60 × 16 | 5.6 |
| factory-c | Factory Building B | 322 × 52 | 12 |
| endblock | Warehouse | 28 × 120 | 17 (+3 parapet) |
| warehouse | Factory Building C | 382 × 54 | 11 |
| passage | O'tish darvozasi | 2 × 16 | 7 |

Official names/functions of the industrial buildings are not known from the references, so neutral names are used.
Rename them in `layout.ts` (`name`, `category`, `info`) — UI and labels follow.

## Automated checks (`apps/web/test/campus.test.ts`)
- the office keeps its original footprint and origin;
- no two buildings intersect (the annex is deliberately attached to the office);
- no road or walkway runs through a building;
- every parking bay is on asphalt and outside buildings;
- every loading door opens onto a road;
- area labels are inside the campus.

## Known simplifications
- Building interiors are not modelled for industrial buildings (inspect view only, as specified).
- Solar arrays are modelled as uniform 10 m strips; real array layout differs per roof.
- Surrounding residential blocks are generic low-detail context, not real buildings.
- Vehicles are three generic silhouettes (sedan, compact SUV, small hatch), mostly white as in the photos.
