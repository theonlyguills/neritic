"""Prepare the Sketchfab "Alma Paulin Fishing Boat" photogrammetry scan as an inshore Cape Island boat.

Usage: blender -b -P scripts/blender/prepare-cape-islander.py -- <model.glb> <bandonboat.jpeg> <out.glb> [--fast]

<model.glb> is the Sketchfab GLB download; <bandonboat.jpeg> is the 8192 px texture from the Sketchfab
"source" archive (the GLB only carries a 1024 px copy; the JPEG is flipped vertically to match the GLB UVs). The scan shows the hull ashore on stands, in grass.

1. Levels the scan on its ground plane and aligns the hull: metres, bow -Y in Blender (bow +Z in glTF), Y up.
2. Cuts the hull 0.45 m above the ground (removes grass, stands, flowers and the unscanned keel; the cut is
   about 0.55 m below the painted waterline) and caps the opening. Trims everything outside the hull's
   half-breadth (boarding stairs, a leaning rack), the stair handrails over the gunwale and a picnic table
   on the aft deck, and fills the deck under the table.
3. Paints out the vessel name on both bows and the transom (normalised blur of the surrounding paint).
4. Replaces the unlit scan material with a lit one (roughness 0.85), decimates to ~140k triangles, and
   bakes Cycles ambient occlusion into a per-vertex COLOR_0 like prepare-trawler.py (softer floor, because
   the photographed texture already carries some daylight shading).
5. Exports GLB: keel cap at y=0, hull centred, waterline ~0.55 m above the cap.
Compression is done afterwards with gltf-transform.
"""
import bpy, bmesh, sys, math, mathutils
import numpy as np

argv = sys.argv[sys.argv.index('--') + 1:]
src, tex_path, out = argv[:3]
FAST = '--fast' in argv  # skip the AO bake (quick geometry/texture check)
CUT = 0.45            # metres above the ground the hull is cut and capped
TARGET_TRIS = 140_000
TEX_SIZE = 4096

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
for o in meshes:
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw
for o in bpy.context.scene.objects:
    o.select_set(o.type == 'MESH')
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
obj.data.transform(obj.matrix_world)
obj.matrix_world = mathutils.Matrix()
for o in list(bpy.context.scene.objects):
    if o is not obj:
        bpy.data.objects.remove(o)
me = obj.data


def coords():
    p = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', p)
    return p.reshape(-1, 3)


# --- 1. level on the ground plane (fitted to the outer ring of grass) and align the hull ---
P = coords()
c = P[:, :2].mean(0)
r = np.linalg.norm(P[:, :2] - c, axis=1)
rim = P[r > r.max() * 0.75]
(ga, gb, gc), *_ = np.linalg.lstsq(np.c_[rim[:, 0], rim[:, 1], np.ones(len(rim))], rim[:, 2], rcond=None)
nrm = np.array([-ga, -gb, 1.0])
nrm /= np.linalg.norm(nrm)
h = (P - np.array([0, 0, gc])) @ nrm
up = P[h > 1.5]
cc = up.mean(0)
_, _, vt = np.linalg.svd(up - cc, full_matrices=False)
bow = vt[0] - nrm * (vt[0] @ nrm)
bow /= np.linalg.norm(bow)
proj = (up - cc) @ bow
hh = h[h > 1.5]
# The bow end carries the higher sheer (and the wheelhouse is forward).
if hh[proj > proj.max() - 2].max() < hh[proj < proj.min() + 2].max():
    bow = -bow
R = np.array([np.cross(-bow, nrm), -bow, nrm])
origin = cc - nrm * ((cc - np.array([0, 0, gc])) @ nrm)
P = (P - origin) @ R.T
me.vertices.foreach_set('co', P.ravel())
me.update()

# --- 2. clean up ---
bm = bmesh.new()
bm.from_mesh(me)
# glTF splits vertices along UV seams and between scan chunks; weld them (UVs stay per corner) so the
# hull is one connected surface and only real holes remain open.
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
bmesh.ops.bisect_plane(bm, geom=geom, plane_co=(0, 0, CUT), plane_no=(0, 0, 1), clear_inner=True)
bm.verts.ensure_lookup_table()
V = np.array([v.co[:] for v in bm.verts])

# Hull half-breadth per 0.25 m station from the clean side (port, -X); starboard has stairs and a rack.
side = (V[:, 2] > CUT + 0.1) & (V[:, 2] < 1.9)
ys = V[side, 1]
y0, y1 = np.percentile(ys, 0.05) - 0.05, np.percentile(ys, 99.95) + 0.05
edges = np.arange(y0, y1 + 0.25, 0.25)
xmin = np.full(len(edges) - 1, np.nan)
xmax = np.full(len(edges) - 1, np.nan)
for i in range(len(edges) - 1):
    s = side & (V[:, 1] >= edges[i]) & (V[:, 1] < edges[i + 1])
    if s.sum() > 20:
        xmin[i] = np.percentile(V[s, 0], 0.5)
        xmax[i] = np.percentile(V[s, 0], 99.5)
mid = 0.5 * (edges[:-1] + edges[1:])
clean = ~np.isnan(xmin) & ((mid < -1.2) | (mid > 3.2))  # away from the stairs and rack
xc = float(np.median(0.5 * (xmin[clean] + xmax[clean])))
half = xc - xmin
half = np.where(np.isnan(half), np.nanmax(half), half)
print(f'HULL centreline x={xc:.3f} stations={len(mid)} y=[{y0:.2f},{y1:.2f}]')
yy = V[:, 1]
idx = np.clip(np.searchsorted(edges, yy) - 1, 0, len(half) - 1)
# Half-breadth also per 0.2 m of height (the bow flares strongly), again from the port side, mirrored.
zedges = np.arange(CUT, V[:, 2].max() + 0.2, 0.2)
half2 = np.full((len(edges) - 1, len(zedges) - 1), np.nan)
port = V[:, 0] < xc
iz_all = np.clip(np.searchsorted(zedges, V[:, 2]) - 1, 0, len(zedges) - 2)
for i in range(len(edges) - 1):
    si = port & (idx == i)
    for j in range(len(zedges) - 1):
        s = si & (iz_all == j)
        if s.sum() > 10:
            half2[i, j] = xc - np.percentile(V[s, 0], 0.5)
for i in range(len(edges) - 1):
    col = half2[i]
    for j in range(len(col)):  # flare: never narrower than below; fill gaps from below / station value
        below = col[:j][~np.isnan(col[:j])]
        if np.isnan(col[j]):
            col[j] = below.max() if len(below) else half[i]
        elif len(below):
            col[j] = max(col[j], below.max() - 0.15)
# Allow a little extra for the rub rail / gunwale cap.
limit = half2[idx, iz_all] + np.where(V[:, 2] < 0.95, 0.03, 0.10)  # tight below the waterline: stand remnants
kill = np.abs(V[:, 0] - xc) > limit
kill |= (yy < y0 - 0.1) | (yy > y1 + 0.15)
# Top of a rack that leaned on the starboard side amidships (outside the hull skin).
kill |= (V[:, 0] - xc > half[idx] + 0.02) & (yy > -1.0) & (yy < 0.6) & (V[:, 2] < 1.7)
# Stair handrails above the starboard gunwale.
kill |= (V[:, 0] > 0.85) & (yy > 1.1) & (yy < 2.6) & (V[:, 2] > 2.05)
# Picnic table on the aft deck: everything above the deck in its footprint.
deckpatch = (np.abs(V[:, 0] - xc) < 1.2) & (yy > 3.0) & (yy < 3.9) & (V[:, 2] < 1.8)
deck_z = float(np.median(V[deckpatch, 2]))
table = (V[:, 0] > -1.6) & (V[:, 0] < 0.55) & (yy > 3.9) & (yy < 6.75) & (V[:, 2] > deck_z + 0.07)
kill |= table
print(f'DECK aft z={deck_z:.3f} table verts={int(table.sum())} trimmed verts={int(kill.sum())}')
bmesh.ops.delete(bm, geom=[v for v, k in zip(bm.verts, kill) if k], context='VERTS')

# Drop small loose fragments (grass tufts, rack pieces) left after trimming.
bm.verts.ensure_lookup_table()
seen = set()
for v in bm.verts:
    if v.index in seen:
        continue
    comp, stack = [], [v]
    seen.add(v.index)
    while stack:
        x = stack.pop()
        comp.append(x)
        for e in x.link_edges:
            w = e.other_vert(x)
            if w.index not in seen:
                seen.add(w.index)
                stack.append(w)
    if len(comp) < 500:
        bmesh.ops.delete(bm, geom=comp, context='VERTS')

# Cap the cut and fill the deck under the table; give new faces the UVs of their boundary corners.
uv = bm.loops.layers.uv.active
before = set(bm.faces)
boundary = [e for e in bm.edges if e.is_boundary]
bmesh.ops.holes_fill(bm, edges=boundary, sides=0)
new = [f for f in bm.faces if f not in before]
bmesh.ops.triangulate(bm, faces=new, quad_method='BEAUTY', ngon_method='BEAUTY')
new = [f for f in bm.faces if f not in before]
newset = set(new)
for f in new:
    # One UV per filled triangle (taken from an original corner of one of its vertices): a flat local
    # colour instead of texture streaks stretched across the patch.
    found = None
    for loop in f.loops:
        for l2 in loop.vert.link_loops:
            if l2.face not in newset and l2.face in before:
                found = l2[uv].uv.copy()
                break
        if found is not None:
            break
    if found is not None:
        for loop in f.loops:
            loop[uv].uv = found
print(f'FILLED faces={len(new)}')

# Recentre: hull centreline x=0, mid-length y=0, lowest point (cap) y_gltf=0.
bm.verts.ensure_lookup_table()
V = np.array([v.co[:] for v in bm.verts])
shift = mathutils.Vector((-xc, -0.5 * (V[:, 1].min() + V[:, 1].max()), -V[:, 2].min()))
bmesh.ops.translate(bm, verts=bm.verts, vec=shift)
bm.to_mesh(me)
bm.free()
# Drop the imported custom split normals: they do not survive the welding/trimming above and make the
# glTF exporter pair UVs with the wrong corners. Smooth shading is right for a scan anyway.
for name in ('custom_normal', 'sharp_face', 'sharp_edge'):
    if name in me.attributes:
        me.attributes.remove(me.attributes[name])
me.shade_smooth()
me.update()
waterline_z = 1.0 + shift.z  # painted boot-top / antifouling line sits ~1.0 m above the ground
print(f'WATERLINE above cap={waterline_z:.3f}')

# --- 3. texture: full resolution source, name painted out, lit material ---
img = bpy.data.images.load(tex_path)
img.scale(TEX_SIZE, TEX_SIZE)
W = H = TEX_SIZE
pix = np.empty(W * H * 4, dtype=np.float32)
img.pixels.foreach_get(pix)
# The source-archive JPEG is stored upside down relative to the GLB's UVs (OBJ vs glTF convention).
pix = np.ascontiguousarray(pix.reshape(H, W, 4)[::-1])

uvl = me.uv_layers.active.data


def region_faces(test):
    out = []
    for p in me.polygons:
        cen = p.center
        if test(cen.x, cen.y, cen.z):
            out.append(p)
    return out


def raster(faces, mask):
    for p in faces:
        pts = np.array([uvl[li].uv[:] for li in p.loop_indices]) * [W, H]
        x0, y0_ = np.floor(pts.min(0)).astype(int)
        x1, y1_ = np.ceil(pts.max(0)).astype(int)
        x0, y0_ = max(x0 - 1, 0), max(y0_ - 1, 0)
        x1, y1_ = min(x1 + 1, W - 1), min(y1_ + 1, H - 1)
        if x1 - x0 > 200 or y1_ - y0_ > 200:
            continue  # cap faces span the atlas; never paint through them
        gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0_, y1_ + 1) + 0.5)
        a, b, c_ = pts[0], pts[1], pts[2]
        d = (b[1] - c_[1]) * (a[0] - c_[0]) + (c_[0] - b[0]) * (a[1] - c_[1])
        if abs(d) < 1e-9:
            continue
        l1 = ((b[1] - c_[1]) * (gx - c_[0]) + (c_[0] - b[0]) * (gy - c_[1])) / d
        l2 = ((c_[1] - a[1]) * (gx - c_[0]) + (a[0] - c_[0]) * (gy - c_[1])) / d
        l3 = 1 - l1 - l2
        e = -0.15
        inside = (l1 >= e) & (l2 >= e) & (l3 >= e)
        mask[y0_:y1_ + 1, x0:x1 + 1] |= inside


def box_blur(a, rad):
    # Separable box blur via cumulative sums (edges clamp).
    for axis in (0, 1):
        n = a.shape[axis]
        cs = np.cumsum(np.pad(a, [(rad + 1, rad) if i == axis else (0, 0) for i in range(a.ndim)], mode='edge'), axis=axis)
        hi = np.take(cs, np.arange(2 * rad + 1, 2 * rad + 1 + n), axis=axis)
        lo = np.take(cs, np.arange(0, n), axis=axis)
        a = (hi - lo) / (2 * rad + 1)
    return a


ymid = shift.y
zoff = shift.z


def sheer(y0w):
    # Underside of the white gunwale cap near the bow, scan frame (rises towards the stem).
    return 2.62 + max(0.0, -2.8 - y0w) * 0.11


def is_bow_name(x, y, z):
    y0w, z0w = y - ymid, z - zoff  # back to scan (ground) frame
    return abs(x) > (0.3 if y0w < -4.6 else 0.9) and -5.9 < y0w < -2.6 and 2.12 < z0w < min(2.62, sheer(y0w) - 0.1)


def is_bow_context(x, y, z):
    # Dark topside paint below the lettering only (never the white cap above it).
    y0w, z0w = y - ymid, z - zoff
    return abs(x) > 0.9 and -5.9 < y0w < -2.2 and 1.55 < z0w <= 2.12


def is_stern_name(x, y, z):
    y0w, z0w = y - ymid, z - zoff
    return y0w > 6.75 and abs(x) < 1.6 and 1.45 < z0w < 2.25


def is_stern_context(x, y, z):
    y0w, z0w = y - ymid, z - zoff
    return y0w > 6.75 and abs(x) < 1.9 and 1.1 < z0w < 2.45 and not is_stern_name(x, y, z)


lum = lambda a: a[..., 0] * 0.2126 + a[..., 1] * 0.7152 + a[..., 2] * 0.0722
for name_test, ctx_test, rad in ((is_bow_name, is_bow_context, 8), (is_stern_name, is_stern_context, 8)):
    nm = np.zeros((H, W), bool)
    cx = np.zeros((H, W), bool)
    raster(region_faces(name_test), nm)
    raster(region_faces(ctx_test), cx)
    # Lettering = band pixels clearly off the band's typical paint tone; the rest of the band (paint
    # between and around the letters) plus nearby topside paint is the colour source.
    rgb = pix[..., :3].copy()
    band_l = lum(rgb)[nm]
    letters = nm & (np.abs(lum(rgb) - np.median(band_l)) > 0.07)
    letters = (box_blur(letters.astype(np.float32), 3) > 0.01) & nm
    valid = ((nm | cx) & ~letters).astype(np.float32)
    todo = letters.copy()
    for _ in range(10):
        num = box_blur(rgb * valid[..., None], rad)
        den = box_blur(valid, rad)[..., None]
        ok = todo & (den[..., 0] > 0.02)
        rgb[ok] = num[ok] / den[ok]
        valid = np.maximum(valid, ok.astype(np.float32))
        todo &= ~ok
        if not todo.any():
            break
    pix[..., :3] = np.where(letters[..., None], rgb, pix[..., :3])
    print(f'NAME band px={int(nm.sum())} repainted px={int(letters.sum())} unresolved={int(todo.sum())}')
img.pixels.foreach_set(pix.ravel())
img.update()
img.file_format = 'JPEG'
img.pack()

mat = bpy.data.materials.new('cape-islander-hull')
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes['Principled BSDF']
bsdf.inputs['Roughness'].default_value = 0.85
bsdf.inputs['Metallic'].default_value = 0.0
tn = nt.nodes.new('ShaderNodeTexImage')
tn.image = img
nt.links.new(tn.outputs['Color'], bsdf.inputs['Base Color'])
me.materials.clear()
me.materials.append(mat)

# --- 4. decimate and bake AO to COLOR_0 ---
tris = sum(len(p.vertices) - 2 for p in me.polygons)
if tris > TARGET_TRIS:
    m = obj.modifiers.new('decimate', 'DECIMATE')
    m.ratio = TARGET_TRIS / tris
    m.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=m.name)
if 'AO' not in me.color_attributes:
    me.color_attributes.new('AO', 'BYTE_COLOR', 'POINT')
me.color_attributes.active_color = me.color_attributes['AO']

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 96
sc.world = bpy.data.worlds.new('w')
obj.select_set(True)
bpy.context.view_layer.objects.active = obj
sc.render.bake.target = 'VERTEX_COLORS'
sc.render.bake.use_selected_to_active = False
sc.world.light_settings.distance = 1.2
if not FAST:
    bpy.ops.object.bake(type='AO')
for d in me.color_attributes['AO'].data:
    v = d.color[0] if not FAST else 1.0
    v = 0.45 + 0.55 * v ** 0.8
    d.color = (v, v, v, 1.0)

V = np.empty(len(me.vertices) * 3)
me.vertices.foreach_get('co', V)
V = V.reshape(-1, 3)
size = V.max(0) - V.min(0)
tris = sum(len(p.vertices) - 2 for p in me.polygons)
print(f'PREPARED tris={tris} verts={len(me.vertices)} length={size[1]:.3f} beam={size[0]:.3f} height={size[2]:.3f}')
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format='GLB',
    export_vertex_color='ACTIVE',
    export_yup=True,
    export_image_format='JPEG',
    export_jpeg_quality=95,
)
