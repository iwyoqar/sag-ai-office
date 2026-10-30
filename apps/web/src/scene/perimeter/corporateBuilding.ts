// CorporateBuilding: the lower office buildings of a company along the ring (5–8 floors), in three forms picked per
// plot, with the company's logo on the upper +z facade.
import { GROUND_H, heightOf, type PlotSpec } from "./layout";
import { facadeLogo } from "./rooftopLogo";
import { plant, roof, vol, type BuildCtx } from "./corporateTower";

const hash = (n: number) => {
  const x = Math.sin(n * 45.3 + 3.7) * 43758.5453;
  return x - Math.floor(x);
};

export function buildCorporateBuilding(ctx: BuildCtx, p: PlotSpec, greenRoofs: boolean) {
  const { b, c, m } = ctx;
  const x = (p.x0 + p.x1) / 2, z = (p.z0 + p.z1) / 2, W = p.x1 - p.x0, D = p.z1 - p.z0;
  const n = p.floors, H = heightOf(n);
  const form = Math.floor(hash(p.seed) * 3);
  const top = greenRoofs ? m.greenRoof : m.roof;
  vol(ctx, c.lobby, x, z, W, D, 0, GROUND_H);
  let ry: number, roofW = W, roofD = D, rx = x, rz = z;
  if (form === 0) {
    // residential-style office slab with balconies front and back (none on the top floor, which carries the sign)
    vol(ctx, c.annex, x, z, W, D, GROUND_H, H);
    for (let k = 1; k <= n - 2; k++) {
      const y = heightOf(k);
      for (const s of [-1, 1]) {
        b.box(W - 2, 0.22, 1.5, c.frame, x, y, z + s * (D / 2 + 0.75));
        b.box(W - 2, 1.05, 0.06, m.railGlass, x, y + 0.22, z + s * (D / 2 + 1.47), 0, false);
      }
    }
    ry = roof(ctx, x, z, W, D, H, top);
  } else if (form === 1) {
    // glass office with the top floor set back behind a terrace
    vol(ctx, c.main, x, z, W, D, GROUND_H, heightOf(n - 1));
    roof(ctx, x, z, W, D, heightOf(n - 1), top);
    roofW = W - 4; roofD = D - 5; rz = z - 1.5;
    vol(ctx, c.main, x, rz, roofW, roofD, heightOf(n - 1), H);
    ry = roof(ctx, x, rz, roofW, roofD, H, top);
  } else {
    // two volumes: a lower wing and a taller block
    const tall = hash(p.seed + 0.4) < 0.5 ? -1 : 1;
    const tw = W * 0.58, tx = x + tall * (W - tw) / 2;
    const lw = W - tw, lx = x - tall * tw / 2;
    const nl = Math.max(3, n - 2);
    vol(ctx, c.annex, lx, z, lw, D, GROUND_H, heightOf(nl));
    roof(ctx, lx, z, lw, D, heightOf(nl), top);
    vol(ctx, c.main, tx, z, tw, D, GROUND_H, H);
    b.box(tw + 0.4, 0.7, D + 0.4, c.accent, tx, H - 1.2, z);
    roofW = tw; rx = tx;
    ry = roof(ctx, tx, z, tw, D, H, top);
  }
  plant(ctx, rx, rz, roofW, roofD, ry, p.seed, 2 + Math.floor(hash(p.seed + 0.8) * 3));
  const face = form === 1 ? rz + roofD / 2 : z + D / 2;
  facadeLogo(b, ctx.logo, m, rx, H, face, Math.min(roofW * 0.6, 16), 2.6);
}
