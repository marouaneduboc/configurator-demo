"""Fast batch unwrap + GLB export. Run inside already-open Blender scene."""
import bpy
import math
import bmesh
from pathlib import Path

ROOT = Path("/Users/fmjduboc/Documents/Configurator demo")
GLB = ROOT / "model.glb"


def mat_name(obj):
    if not obj.material_slots:
        return ""
    mat = obj.material_slots[0].material
    return mat.name if mat else ""


def classify(obj):
    m = (mat_name(obj) or "").replace(" ", "_")
    o = obj.name or ""
    if "Hull_anitfouling" in m:
        return "anti"
    if "Hull_5004" in m or m.startswith("Hull_"):
        return "hull"
    if "Tent_" in m or "Cockpit_roof" in o:
        return "roof"
    if m.startswith("Stof_") or "curtain" in o.lower() or "Cockpit_sofa" in o or o.startswith("Sofa"):
        return "textile"
    if "Construction_9001" in m or "Construction_9003" in m:
        return "super"
    if "Wood_" in m or "sofa_wood" in o.lower() or "Sofa_wood" in o:
        return "wood"
    if "Deck_floor" in m or "Parquet" in m:
        return "deck"
    if "Stainless" in m or "aluminium" in m:
        return "metal"
    if "rope" in (m + o).lower():
        return "rope"
    if "glass" in m:
        return "glass"
    if "Material_light" in m:
        return "light"
    if "blauw" in m:
        return "trim"
    return "other"


def ensure_uv(obj):
    me = obj.data
    if me.uv_layers:
        me.uv_layers.active = me.uv_layers[0]
        return
    me.uv_layers.new(name="UVMap")


def box_unwrap(obj, scale=2.0):
    """Triplanar / box UVs in object space — no bpy.ops, fast."""
    ensure_uv(obj)
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uv_layer = bm.loops.layers.uv.verify()
    bm.faces.ensure_lookup_table()
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    zs = [v.co.z for v in bm.verts]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    minz, maxz = min(zs), max(zs)
    sx = max(maxx - minx, 1e-6)
    sy = max(maxy - miny, 1e-6)
    sz = max(maxz - minz, 1e-6)
    for face in bm.faces:
        n = face.normal
        ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
        for loop in face.loops:
            p = loop.vert.co
            if ay >= ax and ay >= az:
                u = (p.x - minx) / sx
                v = (p.z - minz) / sz
            elif ax >= az:
                u = (p.y - miny) / sy
                v = (p.z - minz) / sz
            else:
                u = (p.x - minx) / sx
                v = (p.y - miny) / sy
            loop[uv_layer].uv = (u * scale, v * scale)
    bm.to_mesh(me)
    bm.free()
    me.update()


def cylinder_unwrap(obj, scale=2.4):
    ensure_uv(obj)
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uv_layer = bm.loops.layers.uv.verify()
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    zs = [v.co.z for v in bm.verts]
    cx = (min(xs) + max(xs)) * 0.5
    cy = (min(ys) + max(ys)) * 0.5
    minz, maxz = min(zs), max(zs)
    span_z = max(maxz - minz, 1e-6)
    for face in bm.faces:
        for loop in face.loops:
            p = loop.vert.co
            u = math.atan2(p.x - cx, p.y - cy) / (2 * math.pi) + 0.5
            v = (p.z - minz) / span_z
            loop[uv_layer].uv = (u * scale, v * scale * 0.55)
    bm.to_mesh(me)
    bm.free()
    me.update()


def planar_unwrap(obj, scale=1.8):
    ensure_uv(obj)
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    uv_layer = bm.loops.layers.uv.verify()
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    minx, maxx = min(xs), max(xs)
    miny, maxy = min(ys), max(ys)
    sx = max(maxx - minx, 1e-6)
    sy = max(maxy - miny, 1e-6)
    for face in bm.faces:
        for loop in face.loops:
            p = loop.vert.co
            loop[uv_layer].uv = (((p.x - minx) / sx) * scale, ((p.y - miny) / sy) * scale)
    bm.to_mesh(me)
    bm.free()
    me.update()


counts = {}
ok = 0
fail = []
if bpy.context.object and bpy.context.object.mode != "OBJECT":
    bpy.ops.object.mode_set(mode="OBJECT")

for obj in list(bpy.data.objects):
    if obj.type != "MESH" or not obj.data or not obj.data.polygons:
        continue
    cat = classify(obj)
    counts[cat] = counts.get(cat, 0) + 1
    if cat in ("glass", "light"):
        continue
    try:
        if cat in ("hull", "anti", "rope"):
            cylinder_unwrap(obj)
        elif cat == "deck":
            planar_unwrap(obj)
        elif cat == "textile":
            box_unwrap(obj, scale=1.4)
        else:
            box_unwrap(obj, scale=1.8)
        ok += 1
    except Exception as e:
        fail.append(f"{obj.name}:{e}")

print("COUNTS", dict(counts))
print("UNWRAPPED", ok, "FAIL", fail[:8])

kwargs = dict(
    filepath=str(GLB),
    export_format="GLB",
    export_texcoords=True,
    export_normals=True,
    export_materials="EXPORT",
    export_apply=True,
    export_yup=True,
    export_cameras=False,
    export_lights=False,
)
try:
    bpy.ops.export_scene.gltf(
        **kwargs,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
    )
    print("EXPORTED_DRACO", str(GLB), "bytes", GLB.stat().st_size)
except TypeError:
    bpy.ops.export_scene.gltf(**kwargs)
    print("EXPORTED", str(GLB), "bytes", GLB.stat().st_size)

bpy.ops.wm.save_mainfile()
print("SAVED_BLEND")
