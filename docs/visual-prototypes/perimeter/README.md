# Corporate perimeter skyline (2026-10-30)

A ring road round the campus and the store district, with the SAG group's 11 companies along its outer side. Each
company has a headquarters tower with a rooftop logo and 4–6 lower office buildings with a facade logo: 60 buildings
in total, in a continuous street front. Code: `apps/web/src/scene/perimeter/`. Tests: `apps/web/test/perimeter.test.ts`.

Screenshots: [campus camera](00-campus-camera.jpg), [wide overview](00-wide-overview.jpg), and one per company below.

| # | Company | Side | Tower form | Floors | Shot |
|---|---|---|---|---|---|
| 1 | SAG (primary SAG logo) | north, behind the HQ | flagship: podium, glass shaft with blue pilasters, open crown, helipad | 15 (tallest) | [01](01-sag.jpg) |
| 2 | SAG Flooring | north | three set-back glass volumes, champagne corner fins | 13 | [02](02-sag-flooring.jpg) |
| 3 | SAG Home Design | north | stone block with roof terrace and pergola, glass block rising from one side | 10 | [03](03-sag-home-design.jpg) |
| 4 | SAG Gardens | east | terraced floors, planters and trees on every terrace, green roof | 8 | [04](04-sag-gardens.jpg) |
| 5 | Maroqand Klaster | east | ribbon-window office, glass atrium, green band, north-light roof | 7 | [05](05-maroqand-klaster.jpg) |
| 6 | Turbo Plast | east | dark metal block, red bands, glass corner, saw-tooth roof lights | 6 | [06](06-turbo-plast.jpg) |
| 7 | SET | south | twin glass towers on a podium, sky bridge | 12 | [07](07-set.jpg) |
| 8 | Jarkurgan Plastic Recycling | south | timber louvres, planted end walls, green roof with solar rows | 6 | [08](08-jarkurgan-plastic-recycling.jpg) |
| 9 | SEAL | west | slender tower in a navy stone frame | 9 | [09](09-seal.jpg) |
| 10 | Bionur Med | west | white slab with rounded ends, a sunshade at every floor | 8 | [10](10-bionur-med.jpg) |
| 11 | Casva | west | charcoal base, cantilevered glass block, orange fascia and fins | 11 | [11](11-casva.jpg) |

## Layout

- **Ring road:** centre lines x −120 / 560 and z −205 / 440, 16 m wide.
  - The M37 crosses it at x −120 and x 560.
  - The south side stays clear of the store district, however its regions pack into rows; this is checked in the tests.
- **Street furniture:** sidewalks on both sides, street trees and lamps, and zebra crossings at the M37 junctions.
- **Open spaces:** a paved plaza with trees at each outer corner, and a surface car park behind every tower.
- **Business park:** on the free land inside the ring, east of the district. It has a footpath loop with diagonals, a pond and tree groves.
- **Building plots:**
  - The companies share the ring's frontage equally, in the owner's order, clockwise from behind the head office.
  - Each tower stands in the middle of its company's stretch.
  - No building touches a road, the campus, the district land or another building; this is checked in the tests.
- **Logos face the aerial camera:** the long side of every tower runs along x, so the +z roof edge carries the sign.
  - Signs are lit panels on steel posts and raking struts, tilted back 14°.
  - On the SAG tower the sign stands on the crown, above its front beam.

## Logos

- **SAG:** uses the official `assets/sag-logo.png`, the same file as the gate wall.
- **The other ten:** cut from the owner's brand sheet into `assets/brands/*.png`.
  - Nothing was redrawn or recoloured. Only the cream card background was made transparent.
  - Aspect ratios are the files' own, and a test checks them against the PNG headers.
- **Resolution:** the sheet was a screenshot, so these files are only 54–203 px wide. They read well from the aerial camera but look soft close up.
  - Dropping higher-resolution originals in under the same names fixes this.
  - If an original has a different aspect ratio, update its `w`/`h` in `perimeter/brands.ts`.

## Not done / limits

- **Assets:** procedural geometry and canvas textures, like the rest of the world. No GLB assets were used.
- **Interaction:** the buildings are context only. They have no picking and no business data; they are not business units.
- **Traffic:** the ring road is not in the traffic graph (`world/network.ts`), so no vehicles use it.
- **Performance:**
  - The perimeter adds about 100 draw calls. Its props are one instanced mesh per kind; per-tile instancing first gave about 300.
  - Campus overview (1440×900, DPR 1, traffic running), measured by the road session: 20.3–24.8 ms per frame with the
    perimeter (1,037 draw calls) against 18.3 ms without it (947 calls). So the perimeter costs about 2–6 ms; it was
    ~40 ms before the instancing change.
- **Empty land:** there is open lawn between the district and the south road. It is the district's room to grow.
