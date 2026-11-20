"""Prepare the Sketchfab "Fishing Trawler 40m" GLB for the vessel scene.

Usage: blender -b -P scripts/blender/prepare-trawler.py -- <source.glb> <out.glb>

1. Splits long edges so large flat panels carry enough vertices for baked occlusion.
2. Bakes Cycles ambient occlusion into a per-vertex COLOR_0 (multiplies base colour in three.js).
3. Exports GLB in the source frame (metres, Y up, bow +Z, keel ~0, waterline ~6.5 m).
Mesh joining and compression are done afterwards with gltf-transform.
"""
import bpy, bmesh, sys, math

src, out = sys.argv[sys.argv.index('--') + 1:]
MAX_EDGE = 0.8  # metres

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']

# Make every mesh single-user so edits apply to all instances consistently.
for o in meshes:
    if o.data.users > 1:
        o.data = o.data.copy()

for o in meshes:
    bm = bmesh.new()
    bm.from_mesh(o.data)
    scale = max(o.matrix_world.to_scale())
    for _ in range(6):
        long = [e for e in bm.edges if e.calc_length() * scale > MAX_EDGE]
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
sc.world.light_settings.distance = 4.0
bpy.ops.object.bake(type='AO')

# Lift the floor so open surfaces stay near white; crevices keep contrast.
for o in meshes:
    attr = o.data.color_attributes['AO']
    for d in attr.data:
        v = d.color[0]
        v = 0.25 + 0.75 * v ** 0.8
        d.color = (v, v, v, 1.0)

tris = sum(len(o.data.polygons) for o in meshes)
verts = sum(len(o.data.vertices) for o in meshes)
print(f'PREPARED meshes={len(meshes)} faces={tris} verts={verts}')
bpy.ops.export_scene.gltf(
    filepath=out,
    export_format='GLB',
    export_vertex_color='ACTIVE',
    export_yup=True,
)
