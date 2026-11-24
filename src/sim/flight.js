import { radius } from './config.js';

export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export const neutral = () => ({ throttle: 0, yaw: 0, pitch: 0, roll: 0 });
export const point = (x = 0, y = 0, z = 0) => ({ x, y, z });
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const angleDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const axes = ['x', 'y', 'z'];
export const goalCoordinate = (p, goal) => Math.hypot(p.y - goal.y, p.z - goal.z);

export function droneAt({ id = 'pilot', team = 0, role = 'striker', x = -1.9, y = radius, z = 0, yaw = 0, ai = false }) {
  return {
    id, team, role, ai, active: true, p: point(x, y, z), prev: point(x, y, z), v: point(),
    yaw, pitch: 0, roll: 0, yawTravel: 0, armed: false, flipped: false, recovering: 0,
    contacts: new Set(), nextContacts: new Set(), crossing: {}, collisions: 0, input: neutral(),
  };
}

export function stepDrone(drone, input, dt, cfg, manual) {
  drone.prev = { ...drone.p };
  drone.nextContacts = new Set();
  if (!drone.active) return;
  if (drone.recovering > 0) {
    drone.recovering = Math.max(0, drone.recovering - dt);
    drone.roll = Math.PI * drone.recovering / .65;
  }
  const live = drone.armed && !drone.flipped && !drone.recovering;
  const assist = !manual && cfg.stabilize;
  const scale = Math.PI / 180 * cfg.tilt;
  const smooth = 1 - Math.exp(-dt * (assist ? 9 : 4.5));
  const pitch = live ? input.pitch * scale * cfg.sensitivity : 0;
  const roll = live ? input.roll * scale * cfg.sensitivity : 0;
  if (!drone.flipped && !drone.recovering) {
    drone.pitch += (clamp(pitch, -scale, scale) - drone.pitch) * smooth;
    drone.roll += (clamp(roll, -scale, scale) - drone.roll) * smooth;
  }
  const turn = live ? input.yaw * 2.65 * cfg.sensitivity * dt : 0;
  drone.yaw += turn;
  drone.yawTravel += turn;
  const c = Math.cos(drone.yaw);
  const s = Math.sin(drone.yaw);
  const forward = Math.sin(drone.pitch);
  const lateral = Math.sin(drone.roll);
  const throttle = clamp(input.throttle, -1, 1);
  // Signed throttle represents displacement around hover for the simulator.
  const gravity = 9.81;
  const tiltLift = Math.cos(drone.pitch) * Math.cos(drone.roll);
  const thrust = live ? Math.max(0, (gravity + throttle * 9.2 * cfg.thrust) / (assist ? tiltLift : 1)) : 0;
  const drag = Math.exp(-dt * (assist ? 2.4 : .72) * cfg.damping);
  drone.v.x = drone.v.x * drag + (c * forward - s * lateral) * thrust * dt;
  drone.v.z = drone.v.z * drag + (s * forward + c * lateral) * thrust * dt;
  drone.v.y = drone.v.y * Math.exp(-dt * (assist ? 4.2 : 1.15) * cfg.damping) + (thrust * tiltLift - gravity) * dt;
  for (const axis of axes) drone.p[axis] += drone.v[axis] * dt;
}

function contact(drone, key, nx, ny, nz, bounce, flip = false) {
  drone.nextContacts.add(key);
  const inward = drone.v.x * nx + drone.v.y * ny + drone.v.z * nz;
  if (inward >= 0) return;
  const kick = -(1 + bounce) * inward;
  drone.v.x += kick * nx;
  drone.v.y += kick * ny;
  drone.v.z += kick * nz;
  if (flip && inward < -3.15 && drone.armed) {
    drone.flipped = true;
    drone.armed = false;
    drone.roll = Math.PI;
  }
}

export function boundDrone(drone, field, bounce) {
  const limits = {
    x: [-field.length / 2 + radius, field.length / 2 - radius],
    y: [radius, field.height - radius],
    z: [-field.width / 2 + radius, field.width / 2 - radius],
  };
  axes.forEach((axis, i) => {
    const [lo, hi] = limits[axis];
    const side = drone.p[axis] < lo ? 1 : drone.p[axis] > hi ? -1 : 0;
    if (!side) return;
    drone.p[axis] = side > 0 ? lo : hi;
    const floor = axis === 'y' && side > 0;
    if (floor && Math.abs(drone.v.y) < .5) {
      drone.v.y = 0;
      drone.v.x *= .97;
      drone.v.z *= .97;
      return;
    }
    contact(drone, axis + side, i === 0 ? side : 0, i === 1 ? side : 0,
      i === 2 ? side : 0, floor ? bounce * .45 : bounce, true);
  });
}

export function collideGoal(drone, goal, bounce) {
  const before = drone.prev;
  const p = drone.p;
  const progress = (p.x - goal.x) * goal.direction;
  const prior = (before.x - goal.x) * goal.direction;
  const state = drone.crossing[goal.id] ??= { entered: false, clean: true };
  const edge = goal.halfDepth + radius;
  const cam = goalCoordinate(p, goal);
  if (progress <= -edge) {
    state.entered = false;
    state.clean = true;
  }
  if (prior <= -edge && progress > -edge) {
    state.entered = true;
    state.clean = true;
  }

  const dx = p.x - goal.x;
  const ry = p.y - goal.y;
  const rz = p.z - goal.z;
  const nearX = clamp(dx, -goal.halfDepth, goal.halfDepth);
  const nearRadial = clamp(cam, goal.inner, goal.outer);
  let nx = dx - nearX;
  let radialNormal = cam - nearRadial;
  let separation = Math.hypot(nx, radialNormal);
  if (separation < radius && Math.abs(dx) < edge) {
    state.clean = false;
    if (separation < 1e-7) {
      nx = (Math.sign(before.x - goal.x) || -goal.direction);
      radialNormal = 0;
      const face = goal.x + nx * (goal.halfDepth + radius);
      p.x = face;
      contact(drone, goal.id, nx, 0, 0, bounce);
      return false;
    }
    nx /= separation;
    radialNormal /= separation;
    const ny = cam ? radialNormal * ry / cam : 0;
    const nz = cam ? radialNormal * rz / cam : 0;
    const correction = radius - separation;
    p.x += nx * correction;
    p.y += ny * correction;
    p.z += nz * correction;
    contact(drone, goal.id, nx, ny, nz, bounce);
    return false;
  }
  // Reject a crossing around the outside of the ring, as well as any contact.
  if (state.entered && prior <= goal.halfDepth && progress >= -goal.halfDepth) {
    if (cam + radius > goal.inner + 1e-6) state.clean = false;
  }
  if (prior < edge && progress >= edge) {
    const valid = state.entered && state.clean;
    state.entered = false;
    return valid;
  }
  return false;
}

export function collideDrones(a, b, bounce) {
  const d = distance(a.p, b.p);
  if (d >= radius * 2) return;
  const nx = d > 1e-6 ? (a.p.x - b.p.x) / d : 1;
  const ny = d > 1e-6 ? (a.p.y - b.p.y) / d : 0;
  const nz = d > 1e-6 ? (a.p.z - b.p.z) / d : 0;
  const push = (radius * 2 - d) * .5;
  a.p.x += nx * push; a.p.y += ny * push; a.p.z += nz * push;
  b.p.x -= nx * push; b.p.y -= ny * push; b.p.z -= nz * push;
  contact(a, b.id, nx, ny, nz, bounce);
  contact(b, a.id, -nx, -ny, -nz, bounce);
}

export function turtle(drone) {
  if (!drone?.active || !drone.flipped || drone.p.y > radius + .025) return false;
  drone.flipped = false;
  drone.recovering = .65;
  drone.armed = false;
  return true;
}

export function autopilot(drone, target, gain) {
  const dx = target.x - drone.p.x;
  const dz = target.z - drone.p.z;
  const c = Math.cos(drone.yaw);
  const s = Math.sin(drone.yaw);
  const x = dx * gain - drone.v.x * .45;
  const z = dz * gain - drone.v.z * .45;
  return {
    throttle: clamp((target.y - drone.p.y) * 1.55 - drone.v.y * .35, -.95, 1),
    yaw: 0,
    pitch: clamp(c * x + s * z, -1, 1),
    roll: clamp(-s * x + c * z, -1, 1),
  };
}
