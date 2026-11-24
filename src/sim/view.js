import * as T from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { arenaDimensions, createArena, createDrone } from '../models.js';

const vector = (x, y, z) => new T.Vector3(x, y, z);
const teamColors = [0xff4e59, 0x3d91ff];
const toVec = p => vector(p.x, p.y, p.z);
const colorMesh = (color, extra = {}) => new T.MeshStandardMaterial({ color, ...extra });
const guide = new T.SphereGeometry(1, 18, 12);

function disposeObject(object) {
  const geometries = new Set();
  const surfaces = new Set();
  object.traverse(mesh => {
    if (!mesh.isMesh && !mesh.isLine) return;
    geometries.add(mesh.geometry);
    if (Array.isArray(mesh.material)) mesh.material.forEach(mat => surfaces.add(mat));
    else surfaces.add(mesh.material);
  });
  geometries.forEach(geometry => { if (geometry !== guide) geometry.dispose(); });
  surfaces.forEach(surface => surface.dispose());
}

function addFilteredNet(arena, dimensions) {
  const net = arena.getObjectByName('Safety net and zip doors');
  const { length, width, height, tubeDiameter } = dimensions;
  const tubeRadius = tubeDiameter / 2;
  const span = length + tubeDiameter;
  const depth = width + tubeDiameter;

  function face(w, h, position, yaw = 0, pitch = 0) {
    const material = new T.MeshBasicMaterial({
      color: 0x223243, transparent: true, depthWrite: false, side: T.DoubleSide,
    });
    material.onBeforeCompile = shader => {
      shader.uniforms.netCells = { value: new T.Vector2(w / .11, h / .11) };
      shader.vertexShader = 'varying vec2 netUv;\n' + shader.vertexShader.replace(
        '#include <uv_vertex>', '#include <uv_vertex>\nnetUv = uv;');
      shader.fragmentShader = 'uniform vec2 netCells;\nvarying vec2 netUv;\n' + shader.fragmentShader.replace(
        '#include <color_fragment>', `#include <color_fragment>
        vec2 cell = netUv * netCells;
        vec2 footprint = max(fwidth(cell), vec2(0.0001));
        vec2 distanceToThread = abs(fract(cell + 0.5) - 0.5);
        vec2 coverage = 1.0 - smoothstep(vec2(0.012), vec2(0.012) + footprint, distanceToThread);
        coverage *= min(vec2(1.0), vec2(0.048) / footprint);
        coverage *= 1.0 - smoothstep(vec2(0.25), vec2(0.72), footprint);
        diffuseColor.a *= 0.78 * max(coverage.x, coverage.y);`);
    };
    const mesh = new T.Mesh(new T.PlaneGeometry(w, h), material);
    mesh.position.set(...position);
    mesh.rotation.set(pitch, yaw, 0);
    net.add(mesh);
  }

  for (const side of [-1, 1]) {
    face(span, height, [0, height / 2 + tubeRadius, side * depth / 2]);
    face(depth, height, [side * span / 2, height / 2 + tubeRadius, 0], Math.PI / 2);
  }
  face(span, depth, [0, height + tubeRadius, 0], 0, -Math.PI / 2);
}

export function chasePose(position, yaw, field) {
  const forward = vector(Math.cos(yaw), 0, Math.sin(yaw));
  const rear = forward.clone().negate();
  // Shorten along the same heading when the camera would pass through the net.
  const clearance = (coordinate, direction, halfSize) => Math.abs(direction) < .0001 ?
    Infinity : (Math.sign(direction) * (halfSize - .08) - coordinate) / direction;
  const distance = T.MathUtils.clamp(Math.min(
    clearance(position.x, rear.x, field.length / 2),
    clearance(position.z, rear.z, field.width / 2),
  ), .45, 1.55);
  const eye = position.clone().addScaledVector(rear, distance);
  eye.y += .34 + .22 * distance;
  eye.y = Math.min(eye.y, field.height - .055);
  const target = position.clone().addScaledVector(forward, .38 * distance);
  target.y += .085;
  return { eye, target };
}

export function createView(container) {
  const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.55));
  renderer.domElement.setAttribute('aria-label', '足球無人機模擬器 3D 場地');
  container.append(renderer.domElement);

  const world = new T.Scene();
  world.background = new T.Color(0x111d2b);
  world.fog = new T.FogExp2(0x111d2b, .039);
  const environment = new RoomEnvironment();
  const pmrem = new T.PMREMGenerator(renderer);
  world.environment = pmrem.fromScene(environment, .06).texture;
  world.environmentIntensity = .56;
  pmrem.dispose();
  environment.dispose();

  const light = new T.DirectionalLight(0xf1faff, 2.05);
  light.position.set(-2, 7, 4);
  light.castShadow = true;
  Object.assign(light.shadow.camera, { left: -7, right: 7, top: 7, bottom: -7, far: 25 });
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.normalBias = .027;
  world.add(light, new T.HemisphereLight(0xc5e8ff, 0x607760, 1.17));

  const ground = new T.Mesh(new T.PlaneGeometry(180, 180), colorMesh(0x151f29));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -.07;
  ground.receiveShadow = true;
  world.add(ground);

  const stadium = new T.Group();
  const shaded = colorMesh(0x233244, { roughness: .78 });
  const structure = new T.BoxGeometry(23, .29, .36);
  const fixture = new T.BoxGeometry(1.35, .037, .14);
  const lamp = new T.MeshBasicMaterial({ color: 0x9ebbc8 });
  for (const side of [-1, 1]) {
    for (let step = 0; step < 6; step++) {
      const row = new T.Mesh(structure, shaded);
      row.position.set(0, step * .28, side * (5.55 + step * .39));
      stadium.add(row);
    }
    for (const x of [-8, -4, 0, 4, 8]) {
      const strip = new T.Mesh(fixture, lamp);
      strip.position.set(x, 4.45, 5 * side);
      stadium.add(strip);
    }
  }
  world.add(stadium);

  const camera = new T.PerspectiveCamera(44, 1, .045, 86);
  const orbit = new OrbitControls(camera, renderer.domElement);
  orbit.enablePan = false;
  orbit.minDistance = 1;
  orbit.maxDistance = 24;
  orbit.maxPolarAngle = Math.PI * .51;
  let view = 'follow';
  let cameraDirty = true;
  let quality = 'medium';

  const dronesGroup = new T.Group();
  const routes = new T.Group();
  const markers = new T.Group();
  world.add(dronesGroup, routes, markers);
  const droneMeshes = new Map();
  const prototypes = teamColors.map((color, team) => {
    const group = new T.Group();
    const drone = createDrone(group);
    if (team === 1) {
      const materials = new Map();
      drone.getObjectByName('Red safety cage').traverse(mesh => {
        if (!mesh.isMesh) return;
        if (!materials.has(mesh.material)) {
          const surface = mesh.material.clone();
          surface.color.setHex(0x2877e8);
          materials.set(mesh.material, surface);
        }
        mesh.material = materials.get(mesh.material);
      });
    }
    return drone;
  });

  let arena;
  let fieldId;
  let routeId;
  let physicalField;
  let replay = false;
  let collisionShift = 0;
  let shakeEnabled = true;

  function changeField(state, practice) {
    const id = JSON.stringify([state.field, state.goals, practice?.cones ?? []]);
    if (id === fieldId) return;
    fieldId = id;
    physicalField = state.field;
    cameraDirty = true;
    if (arena) { world.remove(arena); disposeObject(arena); }
    const dims = { ...arenaDimensions, ...state.field };
    arena = createArena(world, dims, { meshNet: false });
    addFilteredNet(arena, dims);
    const red = arena.getObjectByName('Red goal');
    const blue = arena.getObjectByName('Blue goal');
    for (const target of state.goals) {
      const template = target.direction < 0 ? red : blue;
      const goal = template.clone();
      goal.position.set(target.x, target.y, target.z);
      arena.add(goal);
    }
    // Keep source meshes owned by the arena for disposal.
    red.visible = false;
    blue.visible = false;
    for (const mesh of arena.getObjectByName('Court and markings').children) mesh.receiveShadow = true;
    for (const cone of practice?.cones ?? []) {
      const marker = new T.Mesh(new T.ConeGeometry(.15, .42, 14), colorMesh(0xff932e));
      marker.position.set(cone.x, .21, cone.z);
      arena.add(marker);
    }
    applyQuality();
  }

  function applyQuality() {
    renderer.shadowMap.enabled = quality === 'high';
    if (arena) arena.getObjectByName('Safety net and zip doors').visible = quality !== 'low';
  }

  function addDrone(drone) {
    const wrapper = new T.Group();
    const body = prototypes[drone.team].clone();
    wrapper.add(body);
    const marker = new T.Mesh(new T.RingGeometry(.142, .169, drone.role === 'striker' ? 36 : 6),
      new T.MeshBasicMaterial({ color: teamColors[drone.team], transparent: true, opacity: .90, side: T.DoubleSide }));
    marker.rotation.x = -Math.PI / 2;
    const arrow = new T.Mesh(new T.ConeGeometry(.042, .105, 3), new T.MeshBasicMaterial({ color: teamColors[drone.team] }));
    arrow.position.set(.155, .008, 0);
    arrow.rotation.z = -Math.PI / 2;
    wrapper.add(arrow);
    dronesGroup.add(wrapper, marker);
    const rotors = body.children.filter(node => node.name.startsWith('Rotor '));
    const model = { wrapper, body, marker, rotors };
    droneMeshes.set(drone.id, model);
    return model;
  }

  function updateDrones(drones, own, time, dt) {
    const ids = new Set(drones.map(drone => drone.id));
    for (const [id, entry] of droneMeshes) {
      if (ids.has(id)) continue;
      entry.wrapper.traverse(node => {
        if (node.isMesh && node.geometry.type === 'ConeGeometry') { node.geometry.dispose(); node.material.dispose(); }
      });
      entry.marker.geometry.dispose(); entry.marker.material.dispose();
      dronesGroup.remove(entry.wrapper, entry.marker);
      droneMeshes.delete(id);
    }
    for (const drone of drones) {
      const existing = droneMeshes.get(drone.id);
      const model = existing ?? addDrone(drone);
      model.wrapper.visible = drone.active && !(view === 'fpv' && own === drone.id && !replay);
      model.marker.visible = drone.active && (drone.role === 'striker' || drone.id === own) &&
        !(view === 'fpv' && own === drone.id && !replay);
      const target = toVec(drone.p);
      if (!existing || replay || model.wrapper.position.distanceTo(target) > 1.45) model.wrapper.position.copy(target);
      else model.wrapper.position.lerp(target, Math.min(1, dt * 23));
      model.marker.position.set(model.wrapper.position.x, .006, model.wrapper.position.z);
      model.wrapper.rotation.y = -drone.yaw;
      model.body.rotation.z = -drone.pitch;
      model.body.rotation.x = drone.roll;
      model.rotors.forEach((rotor, index) => {
        if (drone.armed) rotor.rotation.y = (index % 2 ? -1 : 1) * 45 * time + index * Math.PI / 4;
      });
    }
  }

  function clear(layer) {
    for (const child of [...layer.children]) { layer.remove(child); disposeObject(child); }
  }

  function setMarkers(training, hints) {
    const key = training ? [training.level.title, training.stage, training.started, hints, Boolean(training.result)].join('|') : '';
    if (key === routeId) return;
    routeId = key;
    clear(markers);
    if (!training || !hints || training.result) return;
    const stages = !training.started && training.takeoffTarget ?
      [{ p: training.takeoffTarget, radius: .19 }] : training.level.stages.slice(training.stage, training.stage + 5);
    for (const [index, stage] of stages.entries()) {
      if (!stage.p || stage.type === 'check') continue;
      const bright = index === 0;
      const target = new T.Mesh(guide, new T.MeshBasicMaterial({ color: bright ? 0xd7fb79 : 0xb2e7f5,
        transparent: true, opacity: bright ? .38 : .16, depthWrite: false }));
      target.position.copy(toVec(stage.p));
      target.scale.setScalar(stage.type === 'goal' ? .085 : Math.min(stage.radius ?? .28, .32));
      markers.add(target);
      if (bright) {
        const drop = new T.Line(new T.BufferGeometry().setFromPoints([toVec(stage.p), vector(stage.p.x, 0, stage.p.z)]),
          new T.LineBasicMaterial({ color: 0xc9ee79, transparent: true, opacity: .46 }));
        markers.add(drop);
      }
    }
  }

  function cameraStep(state, own, dt) {
    const size = Math.max(state.field.length / 6, state.field.width / 3.8, state.field.height / 3.9, 1);
    const player = state.drones.find(drone => drone.id === own && drone.active) ??
      state.drones.find(drone => drone.active && drone.role === 'striker') ??
      state.drones.find(drone => drone.active);
    const look = vector(0, state.field.height * .40, 0);
    const overviewFit = Math.max(.86, 1.17 / Math.sqrt(camera.aspect));
    let position = vector(4.2, 3.8, 7.7).multiplyScalar(size * overviewFit);
    orbit.enabled = view === 'orbit';
    if (view === 'orbit' && !cameraDirty) { orbit.update(); return; }
    if (view === 'top') {
      position = vector(0, 7.7 * size * Math.max(1, 1 / camera.aspect), .001);
      look.y = 0;
    } else if (view === 'goal') {
      position = vector(state.field.length * .69, 2.1, 0);
      look.y = 1.4;
    } else if (player && ['follow', 'fpv'].includes(view)) {
      const c = Math.cos(player.yaw), s = Math.sin(player.yaw);
      const point = droneMeshes.get(player.id)?.wrapper.position ?? toVec(player.p);
      if (view === 'fpv') {
        position = point.clone().add(vector(c * .10, .055, s * .10));
        look.copy(point).add(vector(c * 2, -player.pitch * .7, s * 2));
      } else {
        const pose = chasePose(point, player.yaw, state.field);
        position = pose.eye;
        look.copy(pose.target);
      }
    } else if (state.field.length > 8) {
      position.z *= 1.11;
    }
    if (shakeEnabled && !replay && collisionShift > 0 && view !== 'top') {
      const offset = Math.sin(state.time * 95) * collisionShift * .02;
      if (view === 'follow') position.y += offset;
      else position.x += offset;
      collisionShift = Math.max(0, collisionShift - dt * 4);
    }
    const ease = cameraDirty || (view === 'follow' && player) ? 1 : Math.min(1, dt * (view === 'fpv' ? 14 : 9));
    camera.position.lerp(position, ease);
    orbit.target.lerp(look, ease);
    camera.lookAt(orbit.target);
    if (cameraDirty && orbit.enabled) orbit.update();
    cameraDirty = false;
  }

  const resize = () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    cameraDirty = true;
  };
  new ResizeObserver(resize).observe(container);
  resize();

  return {
    mode(name) { view = name; cameraDirty = true; },
    quality(value) {
      quality = value;
      renderer.setPixelRatio(value === 'low' ? 1 : Math.min(devicePixelRatio, value === 'high' ? 2 : 1.55));
      applyQuality();
      resize();
    },
    shake(value) { shakeEnabled = value; },
    bump() { collisionShift = 1; },
    draw(state, own, dt, { training, hints = true, playingReplay = false } = {}) {
      replay = playingReplay;
      changeField(state, training?.level);
      setMarkers(training, hints);
      updateDrones(state.drones, own, state.time, dt);
      cameraStep(state, own, dt);
      renderer.render(world, camera);
    },
    paths(paths) {
      clear(routes);
      for (const { frames, color, paint, marks } of paths) {
        if (frames.length < 2) continue;
        const values = frames.map(frame => vector(...frame.p));
        const geometry = new T.BufferGeometry().setFromPoints(values);
        const material = new T.LineBasicMaterial({ color, transparent: true, opacity: .9 });
        if (paint !== 'team') {
          const buffer = frames.flatMap(frame => {
            const t = paint === 'velocity' ? Math.hypot(...frame.v) / 4 : frame.p[1] / (physicalField?.height ?? 3);
            return new T.Color().setHSL((1 - T.MathUtils.clamp(t, 0, 1)) * .58, .92, .60).toArray();
          });
          geometry.setAttribute('color', new T.Float32BufferAttribute(buffer, 3));
          material.vertexColors = true;
          material.color.setHex(0xffffff);
        }
        routes.add(new T.Line(geometry, material));
        if (marks) {
          for (const [frame, markColor] of marks) {
            if (!frame) continue;
            const marker = new T.Mesh(guide, new T.MeshBasicMaterial({ color: markColor }));
            marker.position.set(...frame.p);
            marker.scale.setScalar(.046);
            routes.add(marker);
          }
        }
      }
    },
    image() { return renderer.domElement.toDataURL('image/png'); },
  };
}
