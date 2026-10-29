"""SAG ofis binosi (6 qavat) - protsedural 3D model -> sag-bino.glb

Ishga tushirish:  python 3d/build_sag_building.py
Birliklar: metr. Y - yuqoriga, +Z - binoning old fasadi (ko'cha tomoni).
"""
import io
import json
import math
import os
import struct
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT_DIR = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(OUT_DIR, "sag-bino.glb")

# --- o'lchamlar -------------------------------------------------------------
X0, X1, Z0, Z1 = -18.0, 18.0, -12.0, 8.0      # asosiy blok
PLINTH = 0.75                                  # sokol balandligi
FL = [5.0, 8.6, 12.2, 15.8, 19.4, 23.0]        # 2..6-qavat chegaralari
TOP = 23.0                                     # karniz
ATTIC = 24.8                                   # parapet usti

# old fasaddagi qavariq shisha devor (x -13..7, 1.5 m bo'rtib chiqadi)
ARC_X0, ARC_X1, SAG_ = -13.0, 7.0, 1.5
HALF = (ARC_X1 - ARC_X0) / 2
R_BIG = (HALF ** 2 + SAG_ ** 2) / (2 * SAG_)
CX_BIG = (ARC_X0 + ARC_X1) / 2
CZ_BIG = Z1 + SAG_ - R_BIG
A_BIG = math.asin(HALF / R_BIG)

# o'ng-old burchakdagi yumaloq shisha (markaz 13,3; r=5)
CC_X, CC_Z, R_COR = 13.0, 3.0, 5.0

MATERIALS = {
    "stone":       dict(color=(0.93, 0.87, 0.78), rough=0.85, metal=0.0, tex="stone", uv=4.8),
    "stone_dark":  dict(color=(0.78, 0.72, 0.64), rough=0.9, metal=0.0, tex="stone", uv=4.8),
    "glass":       dict(color=(0.16, 0.38, 0.66), rough=0.06, metal=0.75),
    "glass_dark":  dict(color=(0.08, 0.16, 0.28), rough=0.1, metal=0.6),
    "metal":       dict(color=(0.24, 0.26, 0.29), rough=0.4, metal=0.8),
    "steel":       dict(color=(0.78, 0.79, 0.81), rough=0.3, metal=1.0),
    "logo_navy":   dict(color=(0.03, 0.1, 0.3), rough=0.5, metal=0.0),
    "logo_blue":   dict(color=(0.05, 0.18, 0.45), rough=0.5, metal=0.0),
    "logo_light":  dict(color=(0.2, 0.5, 0.72), rough=0.5, metal=0.0),
    "paving":      dict(color=(1.0, 1.0, 1.0), rough=0.9, metal=0.0, tex="paving", uv=6.0),
    "asphalt":     dict(color=(0.16, 0.16, 0.17), rough=0.95, metal=0.0),
    "paint_white": dict(color=(0.92, 0.92, 0.9), rough=0.6, metal=0.0),
    "red":         dict(color=(0.75, 0.1, 0.1), rough=0.5, metal=0.2),
    "flag_blue":   dict(color=(0.0, 0.6, 0.82), rough=0.8, metal=0.0),
    "flag_green":  dict(color=(0.12, 0.62, 0.25), rough=0.8, metal=0.0),
    "flag_purple": dict(color=(0.45, 0.32, 0.68), rough=0.8, metal=0.0),
}


# --- geometriya yig'uvchi ---------------------------------------------------
class Mesh:
    def __init__(self):
        self.data = defaultdict(list)

    def tri(self, mat, p, n):
        p = [np.asarray(x, float) for x in p]
        n = [np.asarray(x, float) for x in n]
        f = np.cross(p[1] - p[0], p[2] - p[0])
        if np.dot(f, n[0] + n[1] + n[2]) < 0:
            p[1], p[2] = p[2], p[1]
            n[1], n[2] = n[2], n[1]
        self.data[mat].extend(zip(p, n))

    def quad(self, mat, a, b, c, d, n=None, ns=None):
        ns = ns or [n] * 4
        self.tri(mat, [a, b, c], [ns[0], ns[1], ns[2]])
        self.tri(mat, [a, c, d], [ns[0], ns[2], ns[3]])

    def box(self, mat, c, size, R=None):
        R = np.eye(3) if R is None else R
        h = np.asarray(size, float) / 2
        c = np.asarray(c, float)
        for axis in range(3):
            o = [a for a in range(3) if a != axis]
            for sgn in (-1, 1):
                pts = []
                for u, w in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                    idx = [0, 0, 0]
                    idx[axis], idx[o[0]], idx[o[1]] = sgn, u, w
                    pts.append(c + sum(R[:, k] * h[k] * idx[k] for k in range(3)))
                self.quad(mat, *pts, n=R[:, axis] * sgn)

    def prism(self, mat, poly, y0, y1, smooth_deg=12.0, caps=True):
        """Qavariq ko'pburchakni (x, z) y0..y1 oralig'ida cho'zish."""
        P = []
        for p in poly:
            p = np.asarray(p, float)
            if not P or np.linalg.norm(p - P[-1]) > 1e-4:
                P.append(p)
        if np.linalg.norm(P[0] - P[-1]) < 1e-4:
            P.pop()
        n = len(P)
        area = sum(P[i][0] * P[(i + 1) % n][1] - P[(i + 1) % n][0] * P[i][1] for i in range(n))
        sg = 1 if area > 0 else -1
        en = []
        for i in range(n):
            d = P[(i + 1) % n] - P[i]
            en.append(np.array([d[1], 0, -d[0]]) * sg / np.linalg.norm(d))
        cos_t = math.cos(math.radians(smooth_deg))
        for i in range(n):
            j = (i + 1) % n
            na = en[i] + en[i - 1] if np.dot(en[i], en[i - 1]) > cos_t else en[i]
            nb = en[i] + en[j] if np.dot(en[i], en[j]) > cos_t else en[i]
            na, nb = na / np.linalg.norm(na), nb / np.linalg.norm(nb)
            a0 = (P[i][0], y0, P[i][1]); b0 = (P[j][0], y0, P[j][1])
            a1 = (P[i][0], y1, P[i][1]); b1 = (P[j][0], y1, P[j][1])
            self.quad(mat, a0, b0, b1, a1, ns=[na, nb, nb, na])
        if caps:
            c = np.mean(P, axis=0)
            for i in range(n):
                j = (i + 1) % n
                for y, nn in ((y1, (0, 1, 0)), (y0, (0, -1, 0))):
                    self.tri(mat, [(c[0], y, c[1]), (P[i][0], y, P[i][1]), (P[j][0], y, P[j][1])], [nn] * 3)

    def cyl(self, mat, cx, cz, r, y0, y1, seg=16):
        poly = [(cx + r * math.cos(2 * math.pi * k / seg), cz + r * math.sin(2 * math.pi * k / seg)) for k in range(seg)]
        self.prism(mat, poly, y0, y1, smooth_deg=360 / seg + 1)

    def sector(self, mat, cx, cz, r0, r1, a0, a1, y0, y1, seg=24):
        """Halqa sektori: nuqta = (cx + r sin a, cz + r cos a)."""
        A = np.linspace(a0, a1, seg + 1)
        pt = lambda r, a, y: (cx + r * math.sin(a), y, cz + r * math.cos(a))
        for k in range(seg):
            a, b = A[k], A[k + 1]
            na, nb = np.array([math.sin(a), 0, math.cos(a)]), np.array([math.sin(b), 0, math.cos(b)])
            self.quad(mat, pt(r1, a, y0), pt(r1, b, y0), pt(r1, b, y1), pt(r1, a, y1), ns=[na, nb, nb, na])
            self.quad(mat, pt(r0, a, y0), pt(r0, b, y0), pt(r0, b, y1), pt(r0, a, y1), ns=[-na, -nb, -nb, -na])
            for y, nn in ((y1, (0, 1, 0)), (y0, (0, -1, 0))):
                self.quad(mat, pt(r0, a, y), pt(r0, b, y), pt(r1, b, y), pt(r1, a, y), n=nn)
        for a, s in ((a0, -1), (a1, 1)):
            t = np.array([math.cos(a), 0, -math.sin(a)]) * s * (1 if a1 > a0 else -1)
            self.quad(mat, pt(r0, a, y0), pt(r1, a, y0), pt(r1, a, y1), pt(r0, a, y1), n=t)


def yaw(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])


def big_arc(r, a):
    return CX_BIG + r * math.sin(a), CZ_BIG + r * math.cos(a)


def outline(o):
    pts = [(X0 - o, Z0 - o), (X1 + o, Z0 - o), (X1 + o, CC_Z)]
    for a in np.linspace(math.pi / 2, 0, 13)[1:]:
        pts.append((CC_X + (R_COR + o) * math.sin(a), CC_Z + (R_COR + o) * math.cos(a)))
    for a in np.linspace(A_BIG, -A_BIG, 25):
        pts.append(big_arc(R_BIG + o, a))
    pts.append((X0 - o, Z1 + o))
    return pts


M = Mesh()


# --- deraza / balkon --------------------------------------------------------
def window(cx, cz, ang, w, y0, h, balcony=False, mullion=True):
    R = yaw(ang)
    nrm = np.array([math.sin(ang), 0, math.cos(ang)])
    tan = np.array([math.cos(ang), 0, -math.sin(ang)])
    base = np.array([cx, 0, cz])
    at = lambda t, y, n: base + tan * t + nrm * n + np.array([0, y, 0])
    M.box("glass", at(0, y0 + h / 2, 0.02), (w, h, 0.08), R)
    fr, d = 0.16, 0.2
    M.box("stone", at(0, y0 + h + fr / 2, d / 2 - 0.02), (w + 2 * fr, fr, d), R)
    for s in (-1, 1):
        M.box("stone", at(s * (w / 2 + fr / 2), y0 + h / 2, d / 2 - 0.02), (fr, h, d), R)
    if mullion:
        M.box("metal", at(0, y0 + h * 0.72, 0.07), (w, 0.06, 0.04), R)
        if w >= 1.2:
            M.box("metal", at(0, y0 + h / 2, 0.07), (0.06, h, 0.04), R)
    if not balcony:
        M.box("stone", at(0, y0 - 0.06, 0.12), (w + 0.5, 0.12, 0.3), R)
        return
    bw, bd = w + 1.0, 1.1
    M.box("stone", at(0, y0 - 0.1, bd / 2), (bw, 0.2, bd), R)
    M.box("stone", at(0, y0 - 0.26, bd / 2 - 0.05), (bw - 0.2, 0.12, bd - 0.1), R)
    rail_h = 1.0
    M.box("steel", at(0, y0 + rail_h, bd - 0.05), (bw, 0.05, 0.07), R)
    M.box("steel", at(0, y0 + 0.08, bd - 0.05), (bw, 0.04, 0.05), R)
    for s in (-1, 1):
        M.box("steel", at(s * (bw / 2 - 0.04), y0 + rail_h, bd / 2), (0.07, 0.05, bd), R)
        for k in range(int(bd / 0.14)):
            M.box("steel", at(s * (bw / 2 - 0.04), y0 + rail_h / 2, 0.12 + k * 0.14), (0.025, rail_h, 0.025), R)
    n_bars = int(bw / 0.14)
    for k in range(n_bars + 1):
        M.box("steel", at(-bw / 2 + 0.04 + k * (bw - 0.08) / n_bars, y0 + rail_h / 2, bd - 0.05), (0.025, rail_h, 0.025), R)


# --- asosiy hajm --------------------------------------------------------------
M.prism("stone_dark", outline(0.2), 0.0, PLINTH)
M.prism("stone", outline(0.0), PLINTH, TOP)
M.prism("stone", outline(0.3), TOP - 0.45, TOP)
M.prism("stone", outline(0.6), TOP, TOP + 0.35)
M.prism("stone", outline(0.75), TOP + 0.35, TOP + 0.6)
M.prism("stone", outline(-0.05), TOP + 0.6, ATTIC - 0.2)
M.prism("stone", outline(0.12), ATTIC - 0.2, ATTIC)

# qavatlararo tasmalar (faqat tosh devorlarda)
walls = [  # (x0, z0, x1, z1, yaw, uzaytirish)
    (X0, Z0, X1, Z0, math.pi, True),
    (X1, Z0, X1, CC_Z, math.pi / 2, True),
    (X0, Z0, X0, Z1, -math.pi / 2, True),
    (X0, Z1, ARC_X0, Z1, 0.0, False),
    (ARC_X1, Z1, CC_X, Z1, 0.0, False),
]
for y in FL[:-1]:
    for x0, z0, x1, z1, a, ext in walls:
        L = math.hypot(x1 - x0, z1 - z0) + (0.3 if ext else 0.0)
        n = np.array([math.sin(a), 0, math.cos(a)])
        c = np.array([(x0 + x1) / 2, y, (z0 + z1) / 2]) + n * 0.03
        M.box("stone", c, (L, 0.3, 0.3), yaw(a))

# qavariq shisha devor (2..5-qavat)
M.sector("glass", CX_BIG, CZ_BIG, R_BIG + 0.02, R_BIG + 0.08, -A_BIG, A_BIG, FL[0], FL[4] - 0.2, seg=48)
n_mul = 16
for k in range(n_mul + 1):
    a = -A_BIG + 2 * A_BIG * k / n_mul
    x, z = big_arc(R_BIG + 0.14, a)
    M.box("metal", (x, (FL[0] + FL[4]) / 2, z), (0.09, FL[4] - FL[0], 0.14), yaw(a))
for y in FL[:4] + [FL[0] + 1.8, FL[1] + 1.8, FL[2] + 1.8, FL[3] + 1.8]:
    M.sector("metal", CX_BIG, CZ_BIG, R_BIG + 0.08, R_BIG + 0.18, -A_BIG, A_BIG, y - 0.05, y + 0.05, seg=48)
M.sector("stone", CX_BIG, CZ_BIG, R_BIG - 0.1, R_BIG + 0.4, -A_BIG, A_BIG, FL[4] - 0.25, FL[4] + 0.2, seg=48)
# 6-qavat: kichik derazalar egri tosh devorda
for k in range(9):
    a = -A_BIG + (k + 0.5) * 2 * A_BIG / 9
    x, z = big_arc(R_BIG, a)
    window(x, z, a, 1.3, FL[4] + 1.0, 1.6, mullion=False)

# yumaloq burchak shishasi (2..6-qavat va 1-qavat vitrina)
for y0, y1 in ((FL[0], TOP - 0.45), (1.4, 4.5)):
    M.sector("glass", CC_X, CC_Z, R_COR + 0.02, R_COR + 0.08, 0, math.pi / 2, y0, y1, seg=24)
    for k in range(8):
        a = math.pi / 2 * k / 7
        M.box("metal", (CC_X + (R_COR + 0.13) * math.sin(a), (y0 + y1) / 2, CC_Z + (R_COR + 0.13) * math.cos(a)),
              (0.09, y1 - y0, 0.12), yaw(a))
for y in FL[:5] + [4.5, 1.4]:
    M.sector("metal", CC_X, CC_Z, R_COR + 0.06, R_COR + 0.18, 0, math.pi / 2, y - 0.06, y + 0.06, seg=24)

# yon fasaddagi vertikal shisha lenta
M.box("glass", (X1 + 0.03, (FL[0] + TOP - 0.45) / 2, -9.0), (0.08, TOP - 0.45 - FL[0], 2.4))
for y in FL[:5]:
    M.box("metal", (X1 + 0.1, y, -9.0), (0.12, 0.12, 2.4))
for dz in (-1.2, 0.0, 1.2):
    M.box("metal", (X1 + 0.1, (FL[0] + TOP - 0.45) / 2, -9.0 + dz), (0.12, TOP - 0.45 - FL[0], 0.09))

# derazalar ustunlari: (x, z, yaw, balkonmi)
columns = [
    (-15.5, Z1, 0.0, True), (10.0, Z1, 0.0, True),
    (X1, 0.5, math.pi / 2, True), (X1, -4.0, math.pi / 2, True),
    *[(X0, z, -math.pi / 2, False) for z in (5.0, 1.0, -3.0, -7.0)],
    *[(x, Z0, math.pi, False) for x in (-14.0, -9.5, -5.0, -0.5, 4.0, 8.5, 13.0)],
]
for x, z, a, balc in columns:
    for i in range(5):
        if balc and i < 4:
            window(x, z, a, 1.5, FL[i] + 0.1, 2.5, balcony=True)
        else:
            window(x, z, a, 1.6, FL[i] + 0.8, 2.0)
    window(x, z, a, 1.6, 1.5, 2.9)
window(X1, -9.0, math.pi / 2, 2.0, 1.5, 2.9)

# --- kirish podiumi (1-qavat) -------------------------------------------------
PX0, PX1, PZ = -14.3, 8.3, 12.6
M.box("stone_dark", ((PX0 + PX1) / 2, PLINTH / 2, (Z1 + PZ) / 2), (PX1 - PX0, PLINTH, PZ - Z1))
M.box("stone", ((PX0 + PX1) / 2, 4.65, (Z1 + PZ) / 2), (PX1 - PX0, 0.7, PZ - Z1))
M.box("stone", ((PX0 + PX1) / 2, 5.0, (Z1 + PZ + 0.2) / 2), (PX1 - PX0 + 0.4, 0.2, PZ - Z1 + 0.2))
for x in (PX0 + 0.35, PX1 - 0.35):
    M.box("stone", (x, 2.5, (Z1 + PZ) / 2), (0.7, 3.6, PZ - Z1))
M.box("glass", ((PX0 + PX1) / 2, 2.5, 11.0), (PX1 - PX0 - 1.4, 3.6, 0.1))
for k in range(13):
    x = PX0 + 0.7 + k * (PX1 - PX0 - 1.4) / 12
    M.box("metal", (x, 2.5, 11.08), (0.08, 3.6, 0.1))
M.box("metal", ((PX0 + PX1) / 2, 3.4, 11.08), (PX1 - PX0 - 1.4, 0.08, 0.1))
M.box("glass_dark", (-3.0, 1.95, 11.12), (3.6, 2.4, 0.06))
M.box("steel", (-3.0, 1.95, 11.16), (0.05, 2.4, 0.04))
for x in range(-12, 7, 3):
    M.cyl("stone", x, 12.0, 0.34, PLINTH + 0.25, 4.05, seg=20)
    M.box("stone", (x, PLINTH + 0.12, 12.0), (0.9, 0.25, 0.9))
    M.box("stone", (x, 4.15, 12.0), (0.85, 0.2, 0.85))

# podium ustidagi balyustrada
def balustrade(x0, z0, x1, z1):
    p0, p1 = np.array([x0, z0]), np.array([x1, z1])
    L = np.linalg.norm(p1 - p0)
    d = (p1 - p0) / L
    a = math.atan2(d[0], d[1]) - math.pi / 2
    mid = (p0 + p1) / 2
    M.box("stone", (mid[0], 5.18, mid[1]), (L, 0.16, 0.36), yaw(a))
    M.box("stone", (mid[0], 5.98, mid[1]), (L, 0.14, 0.42), yaw(a))
    for k in range(int(L / 0.3)):
        p = p0 + d * (0.15 + k * 0.3)
        M.cyl("stone", p[0], p[1], 0.075, 5.26, 5.91, seg=8)
    for k in range(int(L / 3.0) + 1):
        p = p0 + d * min(k * 3.0, L)
        M.box("stone", (p[0], 5.6, p[1]), (0.36, 0.84, 0.36))

balustrade(PX0 + 0.1, PZ - 0.1, PX1 - 0.1, PZ - 0.1)
balustrade(PX0 + 0.1, Z1 + 0.3, PX0 + 0.1, PZ - 0.1)
balustrade(PX1 - 0.1, Z1 + 0.3, PX1 - 0.1, PZ - 0.1)

# zinapoya
for k in range(5):
    depth = 0.45 * (5 - k)
    M.box("stone_dark", (-3.0, 0.075 * (k + 1), PZ + depth / 2), (12.0 - k * 0.0, 0.15 * (k + 1), depth))

# --- tom: logotip, antenna, texnik qurilmalar --------------------------------
def logo():
    tile, pitch = 0.74, 0.8
    ex, ey, ez = -6.0, 26.9, 9.15
    shade = ["logo_light", "logo_light", "logo_blue", "logo_navy", "logo_navy"]
    for i in range(3):
        for j in range(3):
            u, v = (i - 1) * pitch, (j - 1) * pitch
            x = ex + (u - v) / math.sqrt(2)
            y = ey + (u + v) / math.sqrt(2)
            M.box(shade[(2 - j) + i], (x, y, ez), (tile, tile, 0.3), rot_z(math.pi / 4))

    font = ImageFont.truetype("C:/Windows/Fonts/arialbd.ttf", 400)
    img = Image.new("L", (1400, 520), 0)
    ImageDraw.Draw(img).text((20, 20), "SAG", font=font, fill=255)
    img = img.crop(img.getbbox())
    rows = 120
    img = img.resize((round(img.width * rows / img.height), rows), Image.LANCZOS)
    a = np.array(img) > 127
    height = 2.7
    px = height / rows
    left, top = -4.0, 26.9 + height / 2
    active, rects = {}, []
    for r in range(rows + 1):
        runs = set()
        if r < rows:
            row, c = a[r], 0
            while c < len(row):
                if row[c]:
                    s = c
                    while c < len(row) and row[c]:
                        c += 1
                    runs.add((s, c))
                else:
                    c += 1
        for key in list(active):
            if key not in runs:
                rects.append((*key, active.pop(key), r))
        for key in runs:
            active.setdefault(key, r)
    for c0, c1, r0, r1 in rects:
        M.box("logo_blue", (left + (c0 + c1) / 2 * px, top - (r0 + r1) / 2 * px, ez), ((c1 - c0) * px, (r1 - r0) * px, 0.3))
    right = left + a.shape[1] * px
    for y in (25.6, 28.0):
        M.box("metal", ((-7.5 + right) / 2, y, 8.85), (right + 7.5, 0.14, 0.14))
    for x in np.linspace(-7.2, right - 0.3, 6):
        M.box("metal", (x, (ATTIC + 28.2) / 2, 8.85), (0.12, 28.2 - ATTIC, 0.12))

logo()

# antenna
ax_, az_ = 11.5, -5.0
for k in range(8):
    w = 0.75 - k * 0.06
    M.box("red" if k % 2 == 0 else "paint_white", (ax_, ATTIC + 0.45 + k * 0.9, az_), (w, 0.9, w))
M.cyl("steel", ax_, az_, 0.05, ATTIC + 7.6, ATTIC + 9.0, seg=8)
for s in (-1, 1):
    M.box("paint_white", (ax_ + s * 0.45, ATTIC + 5.5, az_), (0.1, 0.9, 0.5))

# tom ustidagi chiqish va konditsionerlar
M.box("stone", (-9.0, ATTIC + 1.3, -6.0), (5.0, 2.6, 4.0))
M.box("stone", (-9.0, ATTIC + 2.68, -6.0), (5.3, 0.16, 4.3))
for x in (-2.0, 1.0, 4.0):
    M.box("metal", (x, ATTIC + 0.6, -8.0), (2.0, 1.2, 1.4))

# --- atrof: maydon, yo'l, bayroqlar -----------------------------------------
M.box("paving", (0.0, -0.05, 4.0), (110.0, 0.1, 90.0))
M.box("asphalt", (0.0, 0.005, 27.0), (110.0, 0.02, 9.0))
M.box("stone_dark", (0.0, 0.08, 22.4), (110.0, 0.16, 0.25))
for k in range(-13, 14):
    M.box("paint_white", (k * 4.0, 0.02, 27.0), (2.0, 0.01, 0.15))

flags = [(13.0, "flag_purple"), (15.5, None), (18.0, "paint_white")]
for fx, fm in flags:
    fz = 17.0
    M.cyl("steel", fx, fz, 0.07, 0.0, 11.0, seg=10)
    M.cyl("steel", fx, fz, 0.12, 11.0, 11.2, seg=10)
    fy, fw, fh = 10.3, 2.4, 1.2
    if fm:
        M.box(fm, (fx + fw / 2 + 0.07, fy, fz), (fw, fh, 0.03))
    else:  # O'zbekiston bayrog'i
        for col, yy, hh in (("flag_blue", fy + 0.42, 0.4), ("red", fy + 0.205, 0.03),
                            ("paint_white", fy, 0.38), ("red", fy - 0.205, 0.03), ("flag_green", fy - 0.42, 0.4)):
            M.box(col, (fx + fw / 2 + 0.07, yy, fz), (fw, hh, 0.03))


# --- teksturalar --------------------------------------------------------------
def tex_stone():
    rng = np.random.default_rng(7)
    base = np.array([224, 207, 172], float)
    img = np.tile(base, (512, 512, 1)) + rng.normal(0, 5, (512, 512, 1))
    im = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    d = ImageDraw.Draw(im)
    for r in range(8):
        y = r * 64
        d.line([(0, y), (512, y)], fill=(201, 184, 150), width=2)
        off = 0 if r % 2 == 0 else 64
        for x in range(off, 512, 128):
            d.line([(x, y), (x, y + 64)], fill=(206, 190, 156), width=2)
    return im


def tex_paving():
    rng = np.random.default_rng(3)
    im = Image.new("RGB", (512, 512))
    d = ImageDraw.Draw(im)
    for i in range(8):
        for j in range(8):
            g = 168 + int(rng.integers(-8, 9)) + (10 if (i + j) % 2 else 0)
            d.rectangle([i * 64, j * 64, i * 64 + 63, j * 64 + 63], fill=(g, g - 2, g - 6))
            d.line([(i * 64, j * 64), (i * 64 + 63, j * 64)], fill=(130, 128, 124), width=2)
            d.line([(i * 64, j * 64), (i * 64, j * 64 + 63)], fill=(130, 128, 124), width=2)
    return im


def png_bytes(im):
    b = io.BytesIO()
    im.save(b, "PNG", optimize=True)
    return b.getvalue()


# --- GLB eksport --------------------------------------------------------------
def export(path):
    blob = bytearray()
    views, accessors, materials, prims, images, textures = [], [], [], [], [], []

    def add_view(data, target=None):
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), **({"target": target} if target else {})})
        blob.extend(data)
        return len(views) - 1

    tex_index = {}
    for name, im in (("stone", tex_stone()), ("paving", tex_paving())):
        images.append({"bufferView": add_view(png_bytes(im)), "mimeType": "image/png"})
        textures.append({"sampler": 0, "source": len(images) - 1})
        tex_index[name] = len(textures) - 1

    total_tris = 0
    for name, verts in M.data.items():
        spec = MATERIALS[name]
        pos = np.array([v[0] for v in verts], np.float32)
        nrm = np.array([v[1] for v in verts], np.float32)
        nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
        an = np.abs(nrm)
        scale = spec.get("uv", 1.0)
        uv = np.where((an[:, 1] >= an[:, 0]) & (an[:, 1] >= an[:, 2]), 0, np.where(an[:, 0] >= an[:, 2], 1, 2))
        uvs = np.empty((len(pos), 2), np.float32)
        uvs[uv == 0] = pos[uv == 0][:, [0, 2]]
        uvs[uv == 1] = pos[uv == 1][:, [2, 1]] * [1, -1]
        uvs[uv == 2] = pos[uv == 2][:, [0, 1]] * [1, -1]
        uvs /= scale
        allv = np.concatenate([pos, nrm, uvs], axis=1)
        key = np.round(allv, 4)
        uniq, idx, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        allv = allv[idx]
        indices = inv.astype(np.uint32).ravel()
        total_tris += len(indices) // 3
        attrs = {}
        for attr, cols, extra in (("POSITION", slice(0, 3), True), ("NORMAL", slice(3, 6), False), ("TEXCOORD_0", slice(6, 8), False)):
            arr = np.ascontiguousarray(allv[:, cols], np.float32)
            acc = {"bufferView": add_view(arr.tobytes(), 34962), "componentType": 5126, "count": len(arr),
                   "type": "VEC3" if arr.shape[1] == 3 else "VEC2"}
            if extra:
                acc["min"], acc["max"] = arr.min(0).tolist(), arr.max(0).tolist()
            accessors.append(acc)
            attrs[attr] = len(accessors) - 1
        accessors.append({"bufferView": add_view(indices.tobytes(), 34963), "componentType": 5125,
                          "count": len(indices), "type": "SCALAR"})
        pbr = {"baseColorFactor": [*spec["color"], 1.0], "metallicFactor": spec["metal"], "roughnessFactor": spec["rough"]}
        if "tex" in spec:
            pbr["baseColorTexture"] = {"index": tex_index[spec["tex"]]}
        materials.append({"name": name, "pbrMetallicRoughness": pbr})
        prims.append({"attributes": attrs, "indices": len(accessors) - 1, "material": len(materials) - 1})

    gltf = {
        "asset": {"version": "2.0", "generator": "sag-world build_sag_building.py"},
        "scene": 0,
        "scenes": [{"name": "SAG", "nodes": [0]}],
        "nodes": [{"name": "SAG_ofis_binosi", "mesh": 0}],
        "meshes": [{"name": "SAG_ofis_binosi", "primitives": prims}],
        "materials": materials,
        "textures": textures,
        "images": images,
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    while len(blob) % 4:
        blob.append(0)
    gltf["buffers"][0]["byteLength"] = len(blob)
    js = json.dumps(gltf, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(blob)))
        f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
        f.write(struct.pack("<II", len(blob), 0x004E4942) + bytes(blob))
    return total_tris


if __name__ == "__main__":
    tris = export(OUT)
    print(f"{OUT}: {tris} uchburchak, {os.path.getsize(OUT) / 1e6:.2f} MB")
