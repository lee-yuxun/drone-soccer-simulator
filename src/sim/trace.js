import { traceConfig } from './config.js';
import { distance } from './flight.js';

export function newTrace(game) {
  return {
    schemaVersion: 1, matchId: game.id, ruleProfileId: game.profileId, teamSize: game.teamSize,
    startedAt: new Date().toISOString(), field: game.field, goalsGeometry: game.goals, samples: [], strikerSamples: [], goals: [], events: [],
    nextSample: 0, nextStrikerSample: 0,
  };
}

const round = n => Math.round(n * 1000) / 1000;
function sample(drone, time) {
  return {
    t: round(time), id: drone.id, team: drone.team, role: drone.role, active: drone.active,
    p: Object.values(drone.p).map(round),
    v: Object.values(drone.v).map(round),
    rotation: [drone.pitch, drone.yaw, drone.roll].map(round),
  };
}

export function recordFrame(trace, drones, time) {
  const { sampleRate, strikerRate, maxSeconds, before } = traceConfig;
  if (time + .00001 >= trace.nextSample) {
    trace.samples.push(...drones.map(drone => sample(drone, time)));
    trace.nextSample = time + 1 / sampleRate;
    const maxFrames = sampleRate * maxSeconds * Math.max(1, drones.length);
    if (trace.samples.length > maxFrames + 200) trace.samples.splice(0, 200);
  }
  if (time + .00001 < trace.nextStrikerSample) return;
  const current = drones.filter(drone => drone.role === 'striker').map(drone => sample(drone, time));
  trace.strikerSamples.push(...current);
  trace.nextStrikerSample = time + 1 / strikerRate;
  if (trace.strikerSamples[0]?.t < time - before - .1) {
    while (trace.strikerSamples[0]?.t < time - before - .1) trace.strikerSamples.shift();
  }
  for (const goal of trace.goals) {
    if (goal.t + traceConfig.after < time || goal.setEnded) continue;
    const striker = current.find(frame => frame.id === goal.player);
    if (striker) goal.highlight.push(striker);
  }
}

export function recordGoal(trace, event, drone, fieldGoal, game) {
  const t = game.time;
  const team = drone.team;
  const attackStart = game.attackStart[team];
  const [vx, vy, vz] = Object.values(drone.v);
  const nearestDefender = Math.min(...game.drones.filter(other =>
    other.active && other.team !== team && other.role !== 'striker').map(other => distance(other.p, drone.p)));
  const goal = {
    goalId: event.id, set: game.setNumber, team, player: drone.id, score: [...game.score], t: round(t),
    clock: round(game.remaining), start: round(attackStart), direction: fieldGoal.direction,
    x: round(drone.p.x), height: round(drone.p.y), z: round(drone.p.z),
    speed: round(Math.hypot(vx, vy, vz)), angle: round(Math.atan2(Math.hypot(vy, vz), Math.abs(vx)) * 180 / Math.PI),
    defenderDistance: Number.isFinite(nearestDefender) ? round(nearestDefender) : null,
    returned: null,
    highlight: trace.strikerSamples.filter(frame => frame.id === drone.id && frame.t >= t - traceConfig.before),
  };
  goal.highlight.push(sample(drone, t));
  trace.goals.push(goal);
  return goal;
}

export function selectFrames(trace, goal, range) {
  const end = range === 'highlight' ? goal.t + traceConfig.after : goal.t;
  const start = range === 'highlight' ? goal.t - traceConfig.before : goal.start;
  const frames = trace.samples.filter(frame => frame.t >= start && frame.t <= end);
  if (range !== 'highlight' || !goal.highlight?.length) return frames;
  return frames.filter(frame => frame.id !== goal.player).concat(goal.highlight).sort((a, b) => a.t - b.t);
}

export function metrics(trace, goal) {
  const frames = selectFrames(trace, goal, 'attack').filter(frame => frame.id === goal.player);
  let length = 0, peak = 0, speed = 0, height = 0;
  for (const [index, frame] of frames.entries()) {
    if (index) length += Math.hypot(...frame.p.map((value, axis) => value - frames[index - 1].p[axis]));
    const value = Math.hypot(...frame.v);
    height += frame.p[1];
    speed += value;
    peak = Math.max(peak, value);
  }
  return {
    length: round(length), peak: round(peak), meanSpeed: round(speed / Math.max(1, frames.length)),
    meanHeight: round(height / Math.max(1, frames.length)), duration: round(goal.t - goal.start),
    collisions: trace.events.filter(event => event.type === 'collision' && event.player === goal.player &&
      event.t >= goal.start && event.t <= goal.t).length,
  };
}
