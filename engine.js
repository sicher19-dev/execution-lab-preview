/* No Brand Baseball Analytics - Execution Lab scoring engine.
   Pure functions, no DOM, no dependencies. Ported from the prototype page in
   docs/execution-lab/index.html and aligned with the v2 execution report grades.

   Units
     Pitch location: x and z in feet. x is signed the way the tracking feed
     signs plate_x (catcher's view). z is height above the ground.
     Plan rules: boxes are [x0, x1, z0, z1]. x in feet; z either in feet
     (rule.frame.z === 'feet') or in batter-normalized zone units
     (rule.frame.z === 'zone': 0 = bottom of the hitter's zone, 1 = top).
     Miss vectors, distances and spreads: inches.

   Target layers
     glove     - where the catcher set up (feet), null when no glove was read.
     inferred  - glove moved by the pitcher's own aim habit for that pitch.
     plan      - the pitcher's plan box for that pitch in that count. The target
                 is the nearest point of the nearest plan box, so an executed
                 pitch has a zero miss. Graded even with no glove read.

   Grades (plan layer)
     executed    inside a plan box
     centered    in the dead-middle box; checked first, never executed
     near        within near_in inches of a plan box (one ball)
     off strike  off target, but the ball touched the zone
     off ball    off target and out of the zone
*/

export const IN = 12;                  // inches per foot
export const PLATE_HALF_FT = 0.708;    // half the plate width, feet
export const BALL_RADIUS_FT = 0.12;    // a ball touches the zone within this of its edge
export const LAYERS = ['glove', 'inferred', 'plan'];
export const GRADES = ['executed', 'near', 'centered', 'off strike', 'off ball'];
export const GRADE_LABEL = {
  executed: 'executed', near: 'within one ball', centered: 'centered',
  'off strike': 'strike, off target', 'off ball': 'ball, off target',
};
export const GRADE_CODE = { executed: 'E', near: 'N', centered: 'C', 'off strike': 'S', 'off ball': 'B' };

// ---------- small math ----------
export const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// ---------- count state and family ----------
export function stateOf(balls, strikes) { return strikes >= 2 ? '2K' : 'pre2K'; }
export function familyOf(pitchType, rule) {
  return (rule && rule.family_of && rule.family_of[pitchType]) || pitchType;
}

// ---------- boxes ----------
// Offset from a point to a box, in the box's own units. dx/dz are >= 0;
// sx/sz say which side the point is on (-1 below/left, 0 inside, +1 above/right).
export function boxOffset([x, z], [x0, x1, z0, z1]) {
  const sx = x < x0 ? -1 : x > x1 ? 1 : 0, sz = z < z0 ? -1 : z > z1 ? 1 : 0;
  return { dx: sx < 0 ? x0 - x : sx > 0 ? x - x1 : 0, dz: sz < 0 ? z0 - z : sz > 0 ? z - z1 : 0, sx, sz };
}
export const inBox = ([x, z], [x0, x1, z0, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
export const nearestPoint = ([x, z], [x0, x1, z0, z1]) => [clamp(x, x0, x1), clamp(z, z0, z1)];

// Nearest box to a point. zScale converts the z offset to feet (zone height
// for zone-unit rules, 1 for feet). Distance comes back in inches.
export function nearestBox(point, boxes, zScale = 1) {
  let best = null;
  boxes.forEach((box, i) => {
    const o = boxOffset(point, box);
    const d = Math.hypot(o.dx, o.dz * zScale) * IN;
    if (!best || d < best.d) best = { i, box, d, offset: o };
  });
  return best;
}

// Cut a rectangle out of a box: the up-to-four boxes left over. Used to take
// the heart out of the plan boxes, so a score can run to ground that would
// actually have counted as executed.
export function subtractBox(box, cut) {
  const [x0, x1, z0, z1] = box, [cx0, cx1, cz0, cz1] = cut;
  if (x1 <= cx0 || x0 >= cx1 || z1 <= cz0 || z0 >= cz1) return [box];
  const out = [];
  if (x0 < cx0) out.push([x0, cx0, z0, z1]);
  if (x1 > cx1) out.push([cx1, x1, z0, z1]);
  const mx0 = Math.max(x0, cx0), mx1 = Math.min(x1, cx1);
  if (z0 < cz0) out.push([mx0, mx1, z0, cz0]);
  if (z1 > cz1) out.push([mx0, mx1, cz1, z1]);
  return out;
}

// ---------- plan rules ----------
// A plan rule file (see docs/execution-lab/ENGINE.md) holds rules keyed by
// family, count state and batter hand. This resolves the one that applies.
export function resolveRule(planRule, { family, state, hand }) {
  const fam = familyOf(family, planRule);
  const r = planRule.rules.find(q => q.family === fam && q.state === state && q.hand === hand)
    || planRule.rules.find(q => q.family === fam && q.state === state && !q.hand);
  return r ? { ...r, family: fam } : null;
}

function zoneHeight(pitch, planRule) {
  if (pitch.zone) return pitch.zone.top - pitch.zone.bot;
  return (planRule.frame && planRule.frame.z_feet_per_unit) || 1.58;
}
// Pitch z in the rule's frame, plus the factor that turns a z offset in that
// frame into feet. Zone-unit rules need the hitter's zone ({bot, top} in feet)
// or a precomputed zn on the pitch.
function frameZ(pitch, planRule) {
  if (planRule.frame && planRule.frame.z === 'zone') {
    const h = zoneHeight(pitch, planRule);
    if (pitch.zn != null) return { z: pitch.zn, scale: h };
    return { z: (pitch.z - pitch.zone.bot) / h, scale: h };
  }
  return { z: pitch.z, scale: 1 };
}

// Did the ball touch the strike zone? Plate width plus a ball radius either
// side; top and bottom of the hitter's zone plus a ball radius.
export function touchesZone(pitch, planRule) {
  if (Math.abs(pitch.x) > PLATE_HALF_FT + BALL_RADIUS_FT) return false;
  if (pitch.zone) return pitch.z >= pitch.zone.bot - BALL_RADIUS_FT && pitch.z <= pitch.zone.top + BALL_RADIUS_FT;
  if (pitch.zn != null) {
    const pad = BALL_RADIUS_FT / zoneHeight(pitch, planRule);
    return pitch.zn >= -pad && pitch.zn <= 1 + pad;
  }
  const zn = (planRule && planRule.zone_feet) || { lo: 1.6, hi: 3.4 };
  return pitch.z >= zn.lo - BALL_RADIUS_FT && pitch.z <= zn.hi + BALL_RADIUS_FT;
}

// Miss direction, read against the rule's primary (first) box: up/down when
// the vertical miss (in feet) is at least the horizontal one, else in/away
// for the hitter's side. 'middle' when the point sits inside that box.
export function missDirection(offset, zScale, stand) {
  const { dx, dz, sx, sz } = offset;
  if (dx === 0 && dz === 0) return 'middle';
  if (dz * zScale >= dx) return sz > 0 ? 'up' : 'down';
  const towardHitter = stand === 'R' ? sx < 0 : sx > 0;
  return towardHitter ? 'in' : 'away';
}

// Grade one pitch against the plan. Returns null when no rule applies.
//   pitch: { x, z, zone:{bot,top} | zn, family | pitch_type, balls, strikes, stand }
export function gradePlan(pitch, planRule) {
  const state = pitch.state || stateOf(pitch.balls, pitch.strikes);
  const rule = resolveRule(planRule, { family: pitch.family || pitch.pitch_type, state, hand: pitch.stand });
  if (!rule) return null;
  const { z, scale } = frameZ(pitch, planRule);
  const p = [pitch.x, z];
  const heart = planRule.heart;
  const centered = !!heart && Math.abs(pitch.x) < heart.x_half && z > heart.lo && z < heart.hi;
  const near = nearestBox(p, rule.boxes, scale);
  let grade;
  if (centered) grade = 'centered';
  else if (near.d === 0) grade = 'executed';
  else if (near.d < planRule.near_in) grade = 'near';
  else grade = touchesZone(pitch, planRule) ? 'off strike' : 'off ball';
  let tp = nearestPoint(p, near.box), tdist = near.d;
  if (centered && near.d === 0) {
    // A centered pitch inside a plan box: the target is the nearest way out
    // of the middle, and the distance is how far that was.
    const side = pitch.x < 0 ? -heart.x_half : heart.x_half;
    const ways = [[[side, z], Math.abs(side - pitch.x)], [[pitch.x, heart.lo], (z - heart.lo) * scale], [[pitch.x, heart.hi], (heart.hi - z) * scale]];
    ways.sort((a, b) => a[1] - b[1]);
    tp = ways[0][0]; tdist = ways[0][1] * IN;
  }
  const zBase = scale === 1 ? 0 : (pitch.zone ? pitch.zone.bot : pitch.z - z * scale);
  // Scoring ground: the plan boxes with the heart cut out, the nearest point
  // that would have counted as executed. A centered pitch is scored as the
  // miss it is; a pitch whose nearest box point sits in the heart is scored
  // to the box beyond it. Grades and tdist stay as the report defines them.
  const ground = heart ? rule.boxes.flatMap(b => subtractBox(b, [-heart.x_half, heart.x_half, heart.lo, heart.hi])) : rule.boxes;
  const good = ground.length ? nearestBox(p, ground, scale) : near;
  const gp = nearestPoint(p, good.box);
  return {
    grade, code: GRADE_CODE[grade], tdist, box: near.box, boxIndex: near.i, rule,
    target: [tp[0], zBase + tp[1] * scale],
    dgood: good.d, target_good: [gp[0], zBase + gp[1] * scale],
    miss_dir: grade === 'executed' ? '' : centered ? 'middle' : missDirection(boxOffset(p, rule.boxes[0]), scale, pitch.stand),
  };
}

// ---------- layers, miss vectors, scores ----------
export function missVector(actual, target) {
  return target ? [(actual[0] - target[0]) * IN, (actual[1] - target[1]) * IN] : null;
}
export const distance = v => v ? Math.hypot(v[0], v[1]) : null;

// 100 when the miss is zero, 50 when it equals the league median miss for
// that layer, falling off from there.
export function score(d, leagueMedian) {
  if (d == null) return null;
  return 100 * Math.exp(-Math.LN2 * (d / leagueMedian) * (d / leagueMedian));
}

// Score a pitch on every layer. Adds p.m (miss vectors), p.d (inches),
// p.s (scores) and, when a plan rule is given, p.plan and p.grade.
//   league: { glove, inferred, plan } median miss in inches per layer.
// The plan layer's miss runs to the nearest executed ground (the heart cut
// out), so dead-middle scores as a miss.
export function scorePitch(p, { planRule, league }) {
  const actual = [p.x, p.z];
  const targets = { glove: p.glove || null, inferred: p.inferred || null, plan: null };
  if (planRule) {
    p.plan = gradePlan(p, planRule);
    if (p.plan) { p.grade = p.plan.grade; targets.plan = p.plan.target_good; }
  }
  p.m = {}; p.d = {}; p.s = {};
  for (const l of LAYERS) {
    const v = missVector(actual, targets[l]);
    p.m[l] = v; p.d[l] = distance(v); p.s[l] = v ? score(p.d[l], league[l]) : null;
  }
  // Policy: a plan rule may fix the plan-layer score of a centered pitch
  // (centered_score, e.g. 0), whatever its distance. Dead-middle is the plan's
  // call; the glove layers stay pure distance, so a glove set up middle and a
  // pitch that got there still counts against the glove.
  if (p.grade === 'centered' && planRule && planRule.centered_score != null && p.s.plan != null) p.s.plan = planRule.centered_score;
  return p;
}

// ---------- aggregate read for a set of scored pitches ----------
export function aimOffset(P, layer) {
  const S = P.filter(p => p.m && p.m[layer]);
  return S.length ? [mean(S.map(p => p.m[layer][0])), mean(S.map(p => p.m[layer][1]))] : null;
}
export function spread(P, layer) {
  const S = P.filter(p => p.m && p.m[layer]);
  if (!S.length) return null;
  const [bx, bz] = aimOffset(S, layer);
  return median(S.map(p => Math.hypot(p.m[layer][0] - bx, p.m[layer][1] - bz)));
}
// Half-width of the 95% band on the mean score: 1.96 sd / sqrt(n).
export function noiseBand(scores) {
  if (!scores.length) return null;
  const mu = mean(scores), sd = Math.sqrt(mean(scores.map(x => (x - mu) ** 2)));
  return 1.96 * sd / Math.sqrt(scores.length);
}
export function stats(P, layer) {
  const S = P.filter(p => p.m && p.m[layer]);
  if (!S.length) return null;
  const sc = S.map(p => p.s[layer]);
  const bias = aimOffset(S, layer);
  const res = S.map(p => [p.m[layer][0] - bias[0], p.m[layer][1] - bias[1]]);
  const cov = [mean(res.map(r => r[0] * r[0])), mean(res.map(r => r[1] * r[1])), mean(res.map(r => r[0] * r[1]))];
  const graded = P.filter(p => p.grade);
  return {
    n: S.length, total: P.length,
    score: mean(sc), band: noiseBand(sc),
    med: median(S.map(p => p.d[layer])),
    bias, spread: median(res.map(r => Math.hypot(r[0], r[1]))), cov,
    exec: graded.length ? graded.filter(p => p.grade === 'executed').length / graded.length : null,
    cent: graded.length ? graded.filter(p => p.grade === 'centered').length / graded.length : null,
  };
}
export function gradeCounts(P) {
  const c = Object.fromEntries(GRADES.map(g => [g, 0]));
  for (const p of P) if (p.grade) c[p.grade]++;
  return c;
}
// Plain words for a miss vector (inches): 'up / glove side', 'on target'...
export function dirWord([x, z]) {
  const m = Math.hypot(x, z);
  if (m < 0.75) return 'on target';
  const a = [];
  if (Math.abs(z) > m * 0.38) a.push(z > 0 ? 'up' : 'down');
  if (Math.abs(x) > m * 0.38) a.push(x > 0 ? 'glove side' : 'arm side');
  return a.join(' / ');
}
