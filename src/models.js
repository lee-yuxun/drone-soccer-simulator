import * as T from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const v = (x, y, z) => new T.Vector3(x, y, z);
const up = v(0, 1, 0);
const tau = Math.PI * 2;
const material = (color, roughness = .48, metalness = 0) =>
  new T.MeshStandardMaterial({ color, roughness, metalness });

function group(parent, name) {
  const result = new T.Group();
  result.name = name;
  parent.add(result);
  return result;
}

function place(parent, name, geometry, surface, x = 0, y = 0, z = 0) {
  const mesh = new T.Mesh(geometry, surface);
  mesh.name = name;
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

function box(parent, name, surface, x, y, z, width, height, depth) {
  return place(parent, name, new T.BoxGeometry(width, height, depth), surface, x, y, z);
}

function ball(parent, name, surface, position, scale) {
  const mesh = place(parent, name, new T.SphereGeometry(1, 24, 16), surface, ...position);
  mesh.scale.set(...scale);
  return mesh;
}

function cylinderBetween(a, b, radius, sides) {
  const direction = b.clone().sub(a);
  const geometry = new T.CylinderGeometry(radius, radius, direction.length(), sides);
  geometry.applyQuaternion(new T.Quaternion().setFromUnitVectors(up, direction.normalize()));
  geometry.translate(...a.clone().lerp(b, .5).toArray());
  return geometry;
}

function rods(parent, name, surface, segments, radius, sides = 6) {
  const parts = segments.map(([a, b]) => cylinderBetween(a, b, radius, sides));
  const mesh = place(parent, name, mergeGeometries(parts), surface);
  parts.forEach(part => part.dispose());
  return mesh;
}

class SampledCurve extends T.Curve {
  constructor(sample) {
    super();
    this.sample = sample;
  }
  getPoint(t, target = new T.Vector3()) {
    return target.copy(this.sample(t));
  }
}

function tube(sample, radius, segments, closed = false, sides = 8) {
  return new T.TubeGeometry(new SampledCurve(sample), segments, radius, sides, closed);
}

function ringFace(inner, outer, depth) {
  const face = new T.Shape();
  face.absarc(0, 0, outer, 0, tau, false);
  const opening = new T.Path();
  opening.absarc(0, 0, inner, 0, tau, true);
  face.holes.push(opening);
  return new T.ExtrudeGeometry(face, { depth, bevelEnabled: false, curveSegments: 48 })
    .translate(0, 0, -depth / 2);
}

export const arenaDimensions = {
  length: 6, width: 3, height: 3, tubeDiameter: .25,
  goalInnerDiameter: .4, goalOuterDiameter: .7, goalDepth: .1,
  goalCenterHeight: 2, goalInset: 1,
};

export function createArena(scene, dimensions = arenaDimensions, { meshNet = true } = {}) {
  const arena = group(scene, 'Arena');
  arena.userData = { units: 'm', ...dimensions };
  const { length, width, height, tubeDiameter, goalCenterHeight, goalInset,
    goalInnerDiameter, goalOuterDiameter, goalDepth } = dimensions;
  const r = tubeDiameter / 2;
  const x = length / 2 + r;
  const z = width / 2 + r;
  const top = height + r;
  const red = material(0xe12f3f, .36);
  const blue = material(0x2076e6, .36);
  const white = material(0xf2f2ef);
  const black = material(0x171c21, .88);
  const cord = material(0x8d969a, .83);
  const frame = group(arena, 'Inflatable frame');
  const fabric = group(arena, 'Safety net and zip doors');
  const floor = group(arena, 'Court and markings');
  box(floor, 'Turf', material(0x347742, .99), 0, -.034, 0, 2 * (x + r), .062, 2 * (z + r));
  const stripeWidth = length / Math.ceil(length * 2);
  for (let stripe = 0; stripe < Math.ceil(length * 2); stripe++) {
    const surface = material(stripe % 2 ? 0x3f8a4b : 0x397f44, 1);
    box(floor, 'Turf strip', surface, -length / 2 + (stripe + .5) * stripeWidth, -.0015, 0, stripeWidth, .003, width);
  }
  const paint = material(0xe5edd9, .85);
  for (const side of [-1, 1]) {
    box(floor, 'End line', paint, side * (length / 2 - .02), .003, 0, .025, .001, width - .04);
    box(floor, 'Touch line', paint, 0, .0045, side * (width / 2 - .02), length - .04, .001, .025);
    box(floor, 'Goal zone line', paint, side * (length / 2 - goalInset), .003, 0, .021, .001, width - .04);
  }
  box(floor, 'Halfway line', paint, 0, .003, 0, .026, .001, width - .04);
  place(floor, 'Centre circle', ringFace(.432, .45, .001), paint, 0, .0045, 0).rotation.x = -Math.PI / 2;
  const warm = new T.MeshStandardMaterial({ color: 0xff3d59, emissive: 0xff183b, emissiveIntensity: .27 });
  const cool = new T.MeshStandardMaterial({ color: 0x378afa, emissive: 0x226aff, emissiveIntensity: .31 });
  for (const side of [-1, 1]) {
    const surface = side < 0 ? red : blue;
    const edge = side * x;
    const beams = [];
    for (const y of [r, top]) {
      beams.push([v(edge, y, -z), v(edge, y, z)]);
      for (const f of [-z, z]) beams.push([v(0, y, f), v(edge, y, f)]);
    }
    for (const f of [-z, z]) {
      beams.push([v(edge, r, f), v(edge, top, f)]);
      for (const y of [r, top]) ball(frame, 'Rounded corner', surface, [edge, y, f], [r, r, r]);
    }
    rods(frame, side < 0 ? 'Red inflatable tubes' : 'Blue inflatable tubes', surface, beams, r, 24);
    const goal = group(arena, side < 0 ? 'Red goal' : 'Blue goal');
    goal.position.set(side * (length / 2 - goalInset), goalCenterHeight, 0);
    goal.rotation.y = -side * Math.PI / 2;
    goal.userData = { facingInward: [-side, 0, 0], openingDiameter: goalInnerDiameter };
    const inner = goalInnerDiameter / 2;
    const outer = goalOuterDiameter / 2;
    place(goal, 'Annular body', ringFace(inner, outer, goalDepth - .028), black);
    for (const face of [-1, 1]) {
      // Place the panel within the advertised depth.
      place(goal, 'Team colour panel', ringFace(inner, outer, .014),
        side < 0 ? warm : cool, 0, 0, face * (goalDepth / 2 - .007));
    }
    for (let sensor = 0; sensor < 3; sensor++) {
      const angle = sensor * tau / 3 + Math.PI / 2;
      ball(goal, 'Optical sensor housing', black,
        [Math.cos(angle) * (inner + .006), Math.sin(angle) * (inner + .006), .03], [.009, .009, .007]);
    }
    const straps = [-1, 1].map(offset =>
      [v(offset * .19, .29, 0), v(offset * .48, top - goalCenterHeight, 0)]);
    rods(goal, 'Quick release hanging straps', cord, straps, .008);
  }
  rods(frame, 'White centre pillars', white,
    [-z, z].map(f => [v(0, r, f), v(0, top, f)]), r, 24);

  const net = [];
  const nx = Math.ceil((length + 2 * r) / .10);
  const nz = Math.ceil((width + 2 * r) / .10);
  const ny = Math.ceil(height / .10);
  const zippers = [];
  for (const side of [-1, 1]) {
    for (let n = 0; n <= nx; n++) {
      const line = x * (2 * n / nx - 1);
      net.push([v(line, r, side * z), v(line, top, side * z)]);
    }
    for (let n = 0; n <= ny; n++) {
      const y = r + height * n / ny;
      net.push([v(-x, y, side * z), v(x, y, side * z)]);
      net.push([v(side * x, y, -z), v(side * x, y, z)]);
    }
    for (let n = 0; n <= nz; n++) {
      const line = z * (2 * n / nz - 1);
      net.push([v(side * x, r, line), v(side * x, top, line)]);
    }
    const doorX = side * 1.43;
    for (const offset of [-.43, .43]) {
      zippers.push([v(doorX + offset, .14, side * (z + .005)),
        v(doorX + offset, 2.17, side * (z + .005))]);
      box(fabric, 'Zipper pull', cord, doorX + offset, 1.04, side * (z + .015), .021, .066, .015);
    }
    zippers.push([v(doorX - .43, 2.17, side * z), v(doorX + .43, 2.17, side * z)]);
  }
  for (let n = 0; n <= nx; n++) {
    const line = x * (2 * n / nx - 1);
    net.push([v(line, top, -z), v(line, top, z)]);
  }
  for (let n = 0; n <= nz; n++) {
    const line = z * (2 * n / nz - 1);
    net.push([v(-x, top, line), v(x, top, line)]);
  }
  if (meshNet) rods(fabric, 'Square mesh on walls and ceiling', black, net, .00215, 4);
  rods(fabric, 'Door zipper seams', black, zippers, .01);
  return arena;
}

function sphereDirection(a, b, t) {
  const angle = a.angleTo(b);
  return a.clone().multiplyScalar(Math.sin((1 - t) * angle) / Math.sin(angle))
    .addScaledVector(b, Math.sin(t * angle) / Math.sin(angle));
}

function makeCage(parent, surface) {
  const phi = (1 + Math.sqrt(5)) / 2;
  const radius = .0984;
  const bottom = -.083;
  const ringAngle = .204;
  const directions = [];
  for (const a of [-1, 1]) {
    for (const b of [-phi, phi]) {
      directions.push(v(0, a, b).normalize(), v(a, b, 0).normalize(), v(b, 0, a).normalize());
    }
  }
  const pose = new T.Quaternion().setFromAxisAngle(v(0, 0, 1), .12)
    .multiply(new T.Quaternion().setFromAxisAngle(up, .23));
  directions.forEach(direction => direction.applyQuaternion(pose));
  const toCage = point => v(point.x * radius, Math.max(point.y * radius, bottom), point.z * radius);
  const beams = [];
  for (let i = 0; i < directions.length; i++) {
    const point = directions[i];
    const right = v(0, 0, 1).cross(point).normalize();
    const tangent = point.clone().cross(right).normalize();
    beams.push(tube(t => toCage(point.clone().multiplyScalar(Math.cos(ringAngle))
      .addScaledVector(right, Math.cos(t * tau) * Math.sin(ringAngle))
      .addScaledVector(tangent, Math.sin(t * tau) * Math.sin(ringAngle))), .00145, 30, true));
    for (const neighbor of directions.slice(i + 1)) {
      const angle = point.angleTo(neighbor);
      if (angle > 1.2) continue;
      const start = ringAngle / angle;
      beams.push(tube(t => toCage(sphereDirection(point, neighbor, start + (1 - 2 * start) * t)), .00135, 18));
    }
  }
  place(parent, 'Circular openings and curved ribs', mergeGeometries(beams), surface);
  beams.forEach(beam => beam.dispose());
  const baseRadius = Math.sqrt(radius ** 2 - bottom ** 2);
  place(parent, 'Flat landing rim', tube(t => v(Math.cos(t * tau) * baseRadius, bottom,
    Math.sin(t * tau) * baseRadius), .002, 64, true), surface);
  const braces = [];
  for (let i = 0; i < 8; i++) {
    const angle = i * tau / 8;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    ball(parent, 'Shell mounting tab', surface, [.097 * c, 0, .097 * s], [.0038, .003, .0038]);
    braces.push([v(.094 * c, 0, .094 * s), v(.061 * c, 0, .061 * s)]);
  }
  return braces;
}

export function createDrone(scene) {
  const drone = group(scene, 'Drone');
  drone.userData = { units: 'm', nominalGuardDiameter: .2, dimensionsEstimatedFromPhotos: true };
  const cage = group(drone, 'Red safety cage');
  const frame = group(drone, 'White airframe');
  const red = material(0xe52c38, .37);
  const white = material(0xfff8ed, .39);
  const silver = material(0xa1adb2, .26, .73);
  const black = material(0x24252b, .61);
  const copper = material(0xbe843f, .44, .35);
  const led = new T.MeshStandardMaterial({color: 0xfff1bc, emissive: 0xffd59d, emissiveIntensity: .72});
  const braces = makeCage(cage, red);
  const braceSegments = [...braces];
  const rotorPositions = [];
  for (let i = 0; i < 4; i++) {
    const theta = Math.PI / 4 + i * Math.PI / 2;
    const x = Math.cos(theta) * .056;
    const z = Math.sin(theta) * .056;
    rotorPositions.push([x, z]);
    braceSegments.push([v(0, -.009, 0), v(x, -.003, z)]);
  }
  rods(frame, 'Structural spokes and arms', white, braceSegments, .0024, 8);
  place(frame, 'Circular LED carrier',
    tube(t => v(.062 * Math.cos(t * tau), -.004, .062 * Math.sin(t * tau)), .0028, 64, true),
    white);
  for (let i = 0; i < 20; i++) {
    const angle = i * tau / 20;
    const light = box(frame, 'LED chip', led, .0644 * Math.cos(angle), -.004, .0644 * Math.sin(angle), .0015, .003, .0034);
    light.rotation.y = -angle;
    const padAngle = angle + .08;
    const pad = box(frame, 'Copper pads', copper, .0645 * Math.cos(padAngle), -.004, .0645 * Math.sin(padAngle), .001, .0016, .002);
    pad.rotation.y = -padAngle;
  }
  ball(frame, 'Ivory canopy', white, [0, -.002, 0], [.025, .015, .022]);
  box(frame, 'Battery cradle', white, 0, -.025, 0, .041, .025, .03);
  box(frame, 'Battery opening', black, 0, -.025, .015, .029, .013, .002);

  for (const [i, [x, z]] of rotorPositions.entries()) {
    place(frame, 'Motor can', new T.CylinderGeometry(.0054, .0054, .015, 16), silver, x, -.003, z);
    const rotor = group(drone, 'Rotor ' + (i + 1));
    rotor.position.set(x, .0075, z);
    rotor.rotation.y = i * .78 + .25;
    rotor.userData.spinDirection = i % 2 ? -1 : 1;
    place(rotor, 'Propeller hub', new T.CylinderGeometry(.004, .004, .005, 16), white);
    for (const side of [-1, 1]) {
      const blade = ball(rotor, 'Propeller blade', white, [side * .014, 0, 0], [.014, .0012, .0044]);
      blade.rotation.y = side * .18;
    }
  }
  for (const [i, surface] of [black, material(0xd1343a), material(0xf1c540)].entries()) {
    const curve = new T.CubicBezierCurve3(v(.016, -.03, .01 + i * .002), v(.035, -.058, .023),
      v(.042, -.038, .039), v(.041, -.009, .04));
    place(frame, 'Visible wire', new T.TubeGeometry(curve, 20, .00086, 6), surface);
  }
  return drone;
}

function controllerOutline() {
  const outline = new T.Shape();
  outline.moveTo(-.034, .038);
  outline.bezierCurveTo(-.045, .039, -.052, .049, -.071, .043);
  outline.bezierCurveTo(-.096, .038, -.099, .018, -.101, -.002);
  outline.bezierCurveTo(-.104, -.027, -.111, -.052, -.084, -.058);
  outline.bezierCurveTo(-.077, -.061, -.072, -.057, -.066, -.049);
  outline.bezierCurveTo(-.059, -.04, -.052, -.039, -.041, -.039);
  outline.lineTo(.041, -.039);
  outline.bezierCurveTo(.052, -.039, .059, -.04, .066, -.049);
  outline.bezierCurveTo(.072, -.057, .077, -.061, .084, -.058);
  outline.bezierCurveTo(.111, -.052, .104, -.027, .101, -.002);
  outline.bezierCurveTo(.099, .018, .096, .038, .071, .043);
  outline.bezierCurveTo(.052, .049, .045, .039, .034, .038);
  outline.closePath();
  return outline;
}

export function createController(scene) {
  const controller = group(scene, 'Mode 2 controller');
  controller.userData = { units: 'm', dimensionsEstimatedFromPhotos: true };
  const white = material(0xf3f1e9, .36);
  const sideWhite = material(0xd1d6d5, .46);
  const recess = material(0x11151b, .5);
  const black = material(0x222830, .4);
  const softBlack = material(0x333941, .64);
  const metal = material(0xb2bec7, .31, .65);
  const blackMetal = material(0x474e54, .3, .52);
  const shell = group(controller, 'White injection moulded shell');
  const outline = controllerOutline();
  const casing = (depth, bevelSize, bevelThickness) => new T.ExtrudeGeometry(outline, {
    depth, bevelEnabled: true, bevelSize, bevelThickness, bevelSegments: 4, curveSegments: 24,
  });
  place(shell, 'Lower shell', casing(.013, .0035, .004), sideWhite, 0, 0, -.021);
  place(shell, 'Upper shell', casing(.016, .0045, .004), white, 0, 0, -.007);

  function faceCylinder(parent, name, surface, radius, depth, x, y, z, sides = 28) {
    const mesh = place(parent, name, new T.CylinderGeometry(radius, radius, depth, sides), surface, x, y, z);
    mesh.rotation.x = Math.PI / 2;
    return mesh;
  }

  for (const side of [-1, 1]) {
    const x = side * .058;
    const y = .001;
    const gimbal = group(controller, side < 0 ? 'Left gimbal - throttle and yaw' : 'Right gimbal - pitch and roll');
    gimbal.position.set(x, y, .012);
    place(gimbal, 'Raised ivory collar', new T.TorusGeometry(.0211, .0024, 12, 48), white);
    faceCylinder(gimbal, 'Black stick well', recess, .0193, .004, 0, 0, .001);
    box(gimbal, 'Horizontal gimbal carrier', black, 0, 0, .0034, .033, .013, .003);
    box(gimbal, 'Vertical gimbal carrier', softBlack, 0, 0, .0048, .010, .032, .002);
    const stick = group(gimbal, side < 0 ? 'Left stick pivot' : 'Right stick pivot');
    stick.userData.axes = side < 0 ? ['yaw', 'throttle'] : ['roll', 'pitch'];
    faceCylinder(stick, 'Stick boot', recess, .0058, .006, 0, 0, .006);
    faceCylinder(stick, 'Stick shaft', metal, .0024, .013, 0, 0, .014);
    faceCylinder(stick, 'Machined thumb cap', metal, .0062, .007, 0, 0, .022, 24);
    for (let i = 0; i < 12; i++) {
      const theta = i * tau / 12;
      const notch = box(stick, 'Cap fluting', blackMetal, .0049 * Math.cos(theta), .0049 * Math.sin(theta),
        .02565, .0019, .001, .00045);
      notch.rotation.z = theta;
    }
    faceCylinder(stick, 'Thumb cap centre', blackMetal, .0022, .0006, 0, 0, .0257);
    const shoulder = ball(controller, 'Black shoulder button', black, [side * .083, .039, -.004], [.0115, .0045, .0105]);
    shoulder.rotation.z = side * -.35;
    const toggle = group(controller, side < 0 ? 'Left shoulder toggle pivot' : 'Right shoulder toggle pivot');
    toggle.position.set(side * .061, .043, .001);
    place(toggle, 'Hex nut', new T.CylinderGeometry(.005, .005, .0023, 6), metal);
    const switchArm = group(toggle, 'Toggle lever');
    switchArm.rotation.z = side * -.12;
    place(switchArm, 'Toggle shaft', new T.CylinderGeometry(.0017, .0022, .014, 16), metal, 0, .0075, 0);
    ball(switchArm, 'Toggle end', metal, [0, .0146, 0], [.0017, .0017, .0017]);
  }
  const badge = new T.Shape();
  badge.moveTo(-.022, .033);
  badge.lineTo(.022, .033);
  badge.lineTo(.016, .021);
  badge.lineTo(-.016, .021);
  badge.closePath();
  place(controller, 'Black trapezoid badge', new T.ExtrudeGeometry(badge, {
    depth: .001, bevelEnabled: true, bevelThickness: .0006, bevelSize: .0007, bevelSegments: 2,
  }), black, 0, 0, .013);
  for (const [x, y] of [[0, 0], [-.004, 0], [.004, 0], [-.002, .0035], [.002, .0035],
    [-.002, -.0035], [.002, -.0035]]) {
    faceCylinder(controller, 'Speaker aperture', recess, .00087, .00045, x, .011 + y, .01318, 12);
  }
  faceCylinder(controller, 'Lanyard eye mount', black, .0059, .002, 0, -.006, .014);
  place(controller, 'Lanyard eye', new T.TorusGeometry(.0036, .00125, 8, 20), black, 0, -.006, .018).rotation.y = Math.PI / 2;
  box(controller, 'D-pad horizontal', black, -.028, -.024, .015, .026, .008, .004);
  box(controller, 'D-pad vertical', black, -.028, -.024, .0151, .008, .026, .004);
  for (const [x, y] of [[.03, -.014], [.03, -.033], [.02, -.0235], [.04, -.0235]]) {
    faceCylinder(controller, 'Round face button', black, .0046, .0038, x, y, .0145);
  }
  const power = new T.Shape();
  power.moveTo(-.008, -.033);
  power.quadraticCurveTo(0, -.019, .008, -.033);
  power.quadraticCurveTo(.01, -.036, .006, -.036);
  power.lineTo(-.006, -.036);
  power.quadraticCurveTo(-.01, -.036, -.008, -.033);
  place(controller, 'Triangular power button', new T.ExtrudeGeometry(power, {
    depth: .0015, bevelEnabled: true, bevelSize: .0008, bevelThickness: .0008, bevelSegments: 2,
  }), black, 0, 0, .0133);
  return controller;
}
