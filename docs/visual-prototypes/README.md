# Visual system v2 (2026-10-30)

Direction: a polished, colourful, city-builder-style business world (isometric camera, readable sun shadows,
landscaped lots). Everything is built from the project's own procedural geometry and canvas textures; no external
game assets.

Status: the three prototypes below were approved, and the system was then rolled out to the whole world
(see "Rollout" further down).

| Prototype | Unit | Before | After |
|---|---|---|---|
| SAG Headquarters | campus `hq` | [close](before/hq-close.jpg), [wide](before/hq-wide.jpg) | [close](after/hq-close.jpg), [wide](after/hq-wide.jpg) |
| SAG-owned Home Design store | Sag Sergili | [before](before/sag-owned-sergili.jpg) | [after](after/sag-owned-sergili.jpg) |
| Home Design franchise store | Sag Nukus | [before](before/franchise-nukus.jpg) | [after](after/franchise-nukus.jpg), [rear](after/franchise-nukus-rear.jpg), [opened](after/franchise-nukus-interior.jpg) |

## What changed

**Rendering (whole scene)**
- The sun now comes from the front-left of the default camera, so shadows fall on the visible side. Before, it sat
  behind the camera and every shadow was hidden behind its own building.
- Less fill light (hemisphere 1.0 → 0.55, environment 0.75 → 0.45) and a stronger, warmer sun (2.5 → 3.4) give
  shadow contrast. ACES tone mapping stays.
- The shadow box follows the view: about 45 m across up close, up to 300 m from the aerial camera. A 2048 map now
  gives crisper shadows than the old fixed 4096 map. Store districts used to fall outside the old box, so stores cast
  no shadows at all.
- The open land is grass instead of flat beige.

**HQ** (the office model itself is untouched)
- A lawn park behind the office with footpaths, a planted roundel, a tree avenue and groves.
- A west lawn with planting beds against the walls, and a hedge line.
- Grass verges with trees along the parking courtyard.
- Raised planted islands at the parking row ends, and a tree median down the 14 m drive aisle.

**Stores (v2 lot + facade kit, `network/storeLot.ts`, `facadeDetail` in `network/storeLooks.ts`)**
- Lot: a raised paved forecourt behind a curb, planters and bollards, painted parking bays with cars, an accessible
  bay and a zebra crossing to the entrance. Behind those: a drive aisle, a front verge with trees, side lawns with
  trees and shrub lines, parking lamps and a P sign.
- Loading yard: hatched bay, dock door with bumpers, a delivery truck, and a chain-link fence with a gate.
- A SAG totem sign at the lot corner. Its colour band shows ownership: SAG blue for SAG-owned, amber for franchise
  (the same colours as the existing badges).
- Facade: a darker plinth, metal parapet coping, a roof membrane with AC units and ducting, real mullions and floor
  transoms on curtain glass, window reveals and sills on grid facades, and side and rear glazing (only the front was
  glazed before). Also an entrance canopy with a SAG-blue fascia and downlights, side-wall lights, and a rear staff
  door.

Unchanged: Business Unit data, building picking and hover, store opening (the cut-away interior), regional grouping,
labels, auth, agents and the backend.

## Performance (1440×900, DPR 1, same machine and method; times are noisy, take as ranges)

| View | Before ms/frame | After ms/frame (same method) | After, orbiting | Draw calls before → after | Triangles before → after |
|---|---|---|---|---|---|
| HQ close | 28.8 | 23.0 | 19.9 | 83 → 89 | 176k → 205k |
| HQ wide | 33.0 | 17.7 | 13.5 | 116 → 122 | 177k → 205k |
| Sergili | 25.2 | 15.5 | 12.6 | 160 → 195 | 136k → 167k |
| Nukus | — | 14.0 | 9.8 | 91 → 128 | 135k → 166k |

- GPU memory objects: geometries 522 → 300, textures 77 → 36. The campus materials are now one shared set, not
  created twice.
- "Same method" means a full render including a shadow-map redraw every frame, as before. "Orbiting" is what a user
  gets while dragging: on the campus the shadow map is only redrawn after a refit or a scene change.
- Static lot and facade parts are merged per material (`campus/batch.ts`). Repeated props (cars, trees, shrubs,
  lamps, posts, bollards) are instanced across the whole district. A lot adds about 6 draw calls whatever the number
  of stores.
- LOD: lot props are hidden beyond 650 m (raised to 1400 m in the rollout). Store labels already had distance culling. Three.js frustum culling stays on.
- The app renders on demand, as before, so an idle scene costs nothing.

## Rollout (after approval)

Screenshots: [campus overview](rollout/campus-overview.jpg) (before: [overview](before/campus-overview.jpg)),
[store district](rollout/store-district.jpg), [Navoiy stores](rollout/navoiy-stores.jpg),
[hip-roof store](rollout/xasanboy-hip-roof.jpg), [HQ with yard trucks](rollout/hq-wide-yard-trucks.jpg),
[store opened by a real click](rollout/store-opened-click.jpg).

- **All 23 stores**, the head-office unit included, use the v2 lot and facade kit. The photo-based looks (arched ribs,
  hip roof, gables, portals, second brand sign) all fit the deeper lot unchanged.
- **Store district as a city:** the white region plots are now city blocks. Each block has a lawn, a 3 m sidewalk
  behind a curb, and street trees, with groves on unused lawn. 22 m asphalt streets run between and around the
  blocks, with centre dashes, zebra crossings at every junction and corner street lamps.
- **Campus buildings:**
  - Every roller door has a yellow loading bay, dock bumpers and usually a delivery truck backed up to it.
  - Two trucks wait in the service yard.
  - Factory A's M37 frontage has a lawn verge, a clipped hedge and a tree row.
- **Store-account view** (`NetworkScene`) has the same sun as the campus, plus the view-following shadow box and
  on-change shadow redraws.

Rollout performance (same method; this machine was also running other sessions' dev servers, so numbers are noisy):

| View | Full frame ms | Orbiting ms | Draw calls | Triangles |
|---|---|---|---|---|
| Campus overview (default camera, everything on screen) | 26 | 19 | 875 | 535k |
| Store district overview | 23 | 19 | 818 | 533k |
| HQ close | 17 | 14 | 106 | 249k |
| HQ wide | 15 | 11 | 140 | 262k |
| Sergili | 15–29 | 15 | 297 | 356k |
| Nukus | 15 | 10 | 142 | 282k |

What keeps this in budget with all stores detailed:
- Each store's parts are merged per material after assembly (`mergeByMaterial`).
- Identical glass panels share one material across stores.
- The invisible picking boxes no longer cost a draw call.
- District props are instanced per 120 m tile, so frustum culling drops off-screen tiles. This halved close-up
  triangle counts.
- Lot props have an LOD cutoff at 1400 m.

## Still open
- The district has no road link to the M37 yet. The schematic layout has no real addresses, and none were invented.
- Factory roofs are mostly the existing solar arrays, so their facades gained less than the stores did.
- The campus overview is the heaviest view, at about 875 draw calls. The next lever would be merging the unique
  per-store sign textures into an atlas.
- Ambient occlusion: the campus renderer uses a logarithmic depth buffer, which screen-space AO passes misread, so AO
  is approximated with contact shadows, plinths and planted edges instead.
