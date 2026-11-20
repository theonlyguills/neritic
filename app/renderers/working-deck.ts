import * as T from 'three'
import { clone } from 'three/addons/utils/SkeletonUtils.js'

/**
 * Loose deck gear and crew for the "Fishing Trawler 40m" asset, in its own frame:
 * metres, Y up, bow +Z, X across. Measured deck heights (Blender raycasts):
 * aft trawl deck y≈11.9 for z −12…−22; working deck by the net drums y≈10.5 at z −2…2.
 * Rails, ladders, liferafts, winches, drums and the gantry belong to the model itself.
 */
const AFT_DECK = 11.9
const DRUM_DECK = 10.5

export function outfitWorkingDeck(vessel: T.Object3D, crewAsset: T.Object3D) {
  const equipment = new T.Group()
  equipment.name = 'Working deck — net, ropes and fish boxes'
  const ropeMaterial = new T.MeshStandardMaterial({ color: '#8f8467', roughness: 0.95 })
  const rubber = new T.MeshStandardMaterial({ color: '#1b2527', roughness: 0.8 })

  // Trawl net heaped on the aft deck: a lumpy draped surface with mesh lines over it.
  const netShape = (u: number, v: number) =>
    new T.Vector3(
      -3.2 + v * 2.8,
      AFT_DECK +
        0.05 +
        Math.sin(u * Math.PI) * Math.sin(v * Math.PI) * 0.75 +
        Math.sin(v * 13 + u * 7) * 0.09,
      -18 + u * 4.4,
    )
  const netGeometry = new T.PlaneGeometry(1, 1, 40, 26)
  const netPositions = netGeometry.attributes.position!
  for (let i = 0; i < netPositions.count; i++) {
    const p = netShape(netPositions.getX(i) + 0.5, netPositions.getY(i) + 0.5)
    netPositions.setXYZ(i, p.x, p.y, p.z)
  }
  netGeometry.computeVertexNormals()
  const netBody = new T.Mesh(
    netGeometry,
    new T.MeshStandardMaterial({ color: '#26352c', roughness: 0.95, side: T.DoubleSide }),
  )
  netBody.name = 'Trawl net heap'
  equipment.add(netBody)
  const netLines: number[] = []
  const lift = (p: T.Vector3) => p.setY(p.y + 0.03).toArray()
  for (let row = 0; row <= 50; row++)
    for (let col = 0; col < 30; col++)
      netLines.push(
        ...lift(netShape(row / 50, col / 30)),
        ...lift(netShape(row / 50, (col + 1) / 30)),
      )
  for (let col = 0; col <= 30; col++)
    for (let row = 0; row < 50; row++)
      netLines.push(
        ...lift(netShape(row / 50, col / 30)),
        ...lift(netShape((row + 1) / 50, col / 30)),
      )
  equipment.add(
    new T.LineSegments(
      new T.BufferGeometry().setAttribute('position', new T.Float32BufferAttribute(netLines, 3)),
      new T.LineBasicMaterial({ color: '#3c5243' }),
    ),
  )
  const floatMaterial = new T.MeshStandardMaterial({ color: '#c2652c', roughness: 0.6 })
  for (let i = 0; i < 14; i++) {
    const float = new T.Mesh(new T.SphereGeometry(0.14, 12, 8), floatMaterial)
    float.scale.set(1, 1, 1.4)
    float.position.copy(netShape(i / 13, 0.02)).setY(float.position.y + 0.1)
    equipment.add(float)
  }

  // Rope coils.
  for (const [x, y, z] of [
    [-3.4, AFT_DECK, -14.5],
    [3.3, AFT_DECK, -21],
    [-3.2, DRUM_DECK, 1.2],
  ]) {
    const points = []
    for (let i = 0; i <= 220; i++) {
      const a = i * 0.24
      const radius = 0.22 + i * 0.0022
      points.push(
        new T.Vector3(x! + Math.cos(a) * radius, y! + 0.04 + i * 0.0007, z! + Math.sin(a) * radius),
      )
    }
    equipment.add(
      new T.Mesh(
        new T.TubeGeometry(new T.CatmullRomCurve3(points), 220, 0.035, 5, false),
        ropeMaterial,
      ),
    )
  }

  // Stacked fish boxes.
  const crateMaterial = new T.MeshStandardMaterial({ color: '#2f6f86', roughness: 0.7 })
  for (let i = 0; i < 6; i++) {
    const group = new T.Group()
    group.position.set(
      -3.2 + (i % 2) * 0.72,
      AFT_DECK + Math.floor(i / 2) * 0.48,
      -18.2 + (i % 3 === 2 ? 0.05 : 0),
    )
    group.rotation.y = Math.PI / 2 + (i % 3) * 0.04
    for (const [w, h, d, px, py, pz] of [
      [0.94, 0.06, 0.66, 0, 0.03, 0],
      [0.94, 0.42, 0.045, 0, 0.24, -0.32],
      [0.94, 0.42, 0.045, 0, 0.24, 0.32],
      [0.045, 0.42, 0.66, -0.45, 0.24, 0],
      [0.045, 0.42, 0.66, 0.45, 0.24, 0],
    ]) {
      const wall = new T.Mesh(new T.BoxGeometry(w, h, d), crateMaterial)
      wall.position.set(px!, py!, pz!)
      group.add(wall)
    }
    group.name = 'Stacked fish box'
    equipment.add(group)
  }
  vessel.add(equipment)

  // [x, deck y, z, heading]: two hands at the net, one by the drums.
  const positions = [
    [2.4, AFT_DECK, -17.6, -Math.PI * 0.55],
    [-1.4, AFT_DECK, -12.9, Math.PI],
    [2.2, DRUM_DECK, 0.6, -Math.PI * 0.35],
  ]
  positions.forEach(([x, y, z, heading], index) => {
    const crew = clone(crewAsset)
    crew.name = `Deck crew ${index + 1}`
    crew.traverse((object) => {
      if (/Tablet|Clipboard/.test(object.name)) object.visible = index === 2
      const mesh = object as T.Mesh
      if (!mesh.isMesh) return
      mesh.castShadow = true
      mesh.receiveShadow = true
      const recolor = (source: T.Material) => {
        const material = source.clone() as T.MeshStandardMaterial
        if (/top|bottom/i.test(source.name)) {
          material.color.set(index === 0 ? '#ad642f' : index === 1 ? '#c39536' : '#31575a')
          material.roughness = 0.78
        }
        if (/high visibility/i.test(source.name))
          material.color.set(index === 1 ? '#dfb945' : '#c97535')
        return material
      }
      mesh.material = Array.isArray(mesh.material)
        ? mesh.material.map(recolor)
        : recolor(mesh.material)
    })
    const box = new T.Box3().setFromObject(crew)
    const height = box.getSize(new T.Vector3()).y
    const worker = new T.Group()
    worker.add(crew)
    if (index < 2) {
      // Place a coiled handline in the source figure's two-handed working pose.
      const handline = new T.Group()
      handline.position.set(0, 1.176, 0.318)
      handline.rotation.x = 0.436
      for (let turn = 0; turn < 5; turn++) {
        const loop = new T.Mesh(
          new T.TorusGeometry(0.15 + turn * 0.014, 0.012, 6, 28),
          ropeMaterial,
        )
        loop.scale.y = 0.72
        handline.add(loop)
      }
      worker.add(handline)
    }
    worker.scale.setScalar((index === 1 ? 1.72 : 1.82) / height)
    crew.position.y -= box.min.y
    // Rubber work boots cover the original low shoes.
    for (const side of [-1, 1]) {
      const boot = new T.Mesh(new T.CylinderGeometry(0.095, 0.085, 0.33, 12), rubber)
      boot.position.set(side * 0.135, 0.19, 0.04)
      worker.add(boot)
    }
    worker.position.set(x!, y!, z!)
    worker.rotation.y = heading!
    vessel.add(worker)
  })
}
