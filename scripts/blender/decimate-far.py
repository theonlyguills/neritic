"""Far-distance LOD for horizon vessels: blender -b -P decimate-far.py -- <in.glb> <out.glb> [ratio]"""
import bpy, sys
args = sys.argv[sys.argv.index('--') + 1:]
src, out = args[0], args[1]
ratio = float(args[2]) if len(args) > 2 else 0.04
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
for o in [o for o in bpy.context.scene.objects if o.type == 'MESH']:
    if len(o.data.polygons) < 60:
        continue
    m = o.modifiers.new('decimate', 'DECIMATE')
    m.ratio = ratio
    bpy.context.view_layer.objects.active = o
    bpy.ops.object.modifier_apply(modifier=m.name)
print('FAR faces', sum(len(o.data.polygons) for o in bpy.context.scene.objects if o.type == 'MESH'))
bpy.ops.export_scene.gltf(filepath=out, export_format='GLB', export_vertex_color='ACTIVE', export_yup=True)
