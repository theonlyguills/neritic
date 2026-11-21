"""Prepare the Sketchfab "Fishing Vessel IV" (a West Coast-style seiner) for the vessel scene.

Usage: blender -b -P scripts/blender/prepare-pacific-seiner.py -- <source.glb> <out.glb> [length_m]

Generalises prepare-trawler.py for a modelled (non-scan) boat whose source is not in metres:
1. Applies all transforms, drops coincident duplicate slabs, checks the frame (bow -Y in Blender = bow +Z in glTF, Y up) and scales the hull
   to the requested overall length (default 17 m, a typical BC limit seiner).
2. Reduces the triangle budget to ~105k (before edge splitting): each object over a common cap is first planar-dissolved, then
   collapse-decimated to the cap (the dense parts are bevelled deckhouse walls, the net pile and fish).
3. Splits long edges so large flat panels carry enough vertices for baked occlusion.
4. Bakes Cycles ambient occlusion into a per-vertex COLOR_0 (multiplies base colour in three.js).
5. Exports GLB with the keel at y=0; the painted waterline is printed for the scene config.
Mesh joining and compression are done afterwards with gltf-transform.
"""
import bpy, bmesh, sys, math
import numpy as np

args = sys.argv[sys.argv.index('--') + 1:]
src, out = args[0], args[1]
LENGTH = float(args[2]) if len(args) > 2 else 17.0
TARGET_TRIS = 105_000
WATERLINE_SRC = 0.62   # top of the dark antifouling band in source units (side render), keel at ~0.086

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']

for o in meshes:
    if o.data.users > 1:
        o.data = o.data.copy()
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw
for o in list(bpy.context.scene.objects):
    if o.type != 'MESH':
        bpy.data.objects.remove(o)
for o in meshes:
    o.data.transform(o.matrix_world)
    o.matrix_world.identity()

# The deck and deckhouse-roof slabs are each modelled twice, coincident (same material and bounds); the
# copies z-fight in the source and break apart once decimated. Keep the denser copy of each pair.
def obj_bounds(o):
    p = np.empty(len(o.data.vertices) * 3)
    o.data.vertices.foreach_get('co', p)
    p = p.reshape(-1, 3)
    return np.r_[p.min(0), p.max(0)]


bb = {o.name: obj_bounds(o) for o in meshes}
dupes = set()
for i, a in enumerate(meshes):
    for b in meshes[i + 1:]:
        if a.name in dupes or b.name in dupes or a.data.materials[:] != b.data.materials[:]:
            continue
        if np.abs(bb[a.name] - bb[b.name]).max() < 0.01:
            dupes.add(min((a, b), key=lambda o: len(o.data.polygons)).name)
meshes = [o for o in meshes if o.name not in dupes]
for name in sorted(dupes):
    print(f'DUPLICATE removed {name}')
    bpy.data.objects.remove(bpy.data.objects[name])


def bounds():
    pts = []
    for o in meshes:
        p = np.empty(len(o.data.vertices) * 3)
        o.data.vertices.foreach_get('co', p)
        pts.append(p.reshape(-1, 3))
    p = np.concatenate(pts)
    return p.min(0), p.max(0)


lo, hi = bounds()
# The source is already bow -Y (name and wheelhouse forward); hull length is the Y extent.
k = LENGTH / (hi[1] - lo[1])
waterline_src = WATERLINE_SRC - lo[2]
for o in meshes:
    me = o.data
    p = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get('co', p)
    p = p.reshape(-1, 3)
    p = (p - [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]]) * k
    me.vertices.foreach_set('co', p.ravel())
    me.update()
print(f'SCALE k={k:.4f} source length={hi[1] - lo[1]:.3f}')

# Water-fill a per-object triangle cap so the total meets the budget.
tris = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes}
lo_c, hi_c = 0.0, float(max(tris.values()))
for _ in range(60):
    c = (lo_c + hi_c) / 2
    if sum(min(t, c) for t in tris.values()) > TARGET_TRIS:
        hi_c = c
    else:
        lo_c = c
cap = int(lo_c)
print(f'CAP {cap} per object (before {sum(tris.values())})')
for o in meshes:
    if tris[o.name] <= cap:
        continue
    bpy.context.view_layer.objects.active = o
    m = o.modifiers.new('planar', 'DECIMATE')
    m.decimate_type = 'DISSOLVE'
    m.angle_limit = math.radians(1.0)
    m.delimit = {'UV', 'MATERIAL'}
    bpy.ops.object.modifier_apply(modifier=m.name)
    t = sum(len(p.vertices) - 2 for p in o.data.polygons)
    if t > cap:
        m = o.modifiers.new('collapse', 'DECIMATE')
        m.ratio = cap / t
        m.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=m.name)

MAX_EDGE = 0.9  # metres
for o in meshes:
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    for _ in range(6):
        long = [e for e in bm.edges if e.calc_length() > MAX_EDGE]
        if not long:
            break
        bmesh.ops.subdivide_edges(bm, edges=long, cuts=1, use_grid_fill=True)
        bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bm.to_mesh(o.data)
    bm.free()
    if 'AO' not in o.data.color_attributes:
        o.data.color_attributes.new('AO', 'BYTE_COLOR', 'POINT')
    o.data.color_attributes.active_color = o.data.color_attributes['AO']

sc = bpy.context.scene
sc.render.engine = 'CYCLES'
sc.cycles.device = 'CPU'
sc.cycles.samples = 96
sc.world = bpy.data.worlds.new('w')
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
sc.render.bake.target = 'VERTEX_COLORS'
sc.render.bake.use_selected_to_active = False
sc.world.light_settings.distance = 1.8
bpy.ops.object.bake(type='AO')
for o in meshes:
    for d in o.data.color_attributes['AO'].data:
        v = d.color[0]
        v = 0.25 + 0.75 * v ** 0.8
        d.color = (v, v, v, 1.0)

lo, hi = bounds()
tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)
print(f'PREPARED meshes={len(meshes)} tris={tris} size=({hi[0]-lo[0]:.3f}, {hi[1]-lo[1]:.3f}, {hi[2]-lo[2]:.3f}) '
      f'waterline_above_keel={waterline_src * k:.3f}')
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format='GLB',
    export_vertex_color='ACTIVE',
    export_yup=True,
)
