//! Battery cycle ageing from a cycle-life curve: rainflow counting of the stored energy (ASTM E1049-85, three-point method)
//! and Miner's rule against cycles to end of life by depth of discharge.

/// Cycles to end of life at depth of discharge `dod` (share of nameplate) from 2 to 4 datasheet points (DoD, cycles) in
/// rising DoD. Between points the curve is a straight line in log-log; outside them the energy to end of life (cycles x
/// depth) of the nearest point is held, so depths shallower than the shallowest point earn no further life per kWh and deeper
/// ones lose none.
pub fn cycles_at(curve: &[(f64, f64)], dod: f64) -> f64 {
    let (first, last) = (curve[0], curve[curve.len() - 1]);
    if dod <= first.0 { return first.1 * first.0 / dod; }
    if dod >= last.0 { return last.1 * last.0 / dod; }
    let i = curve.windows(2).position(|w| dod <= w[1].0).unwrap_or(curve.len() - 2);
    let ((d0, n0), (d1, n1)) = (curve[i], curve[i + 1]);
    (n0.ln() + (dod / d0).ln() / (d1 / d0).ln() * (n1 / n0).ln()).exp()
}

/// Wear cost per kWh discharged for the planner: the replacement cost per kWh of nameplate over the energy to end of life
/// (cycles x depth) of a cycle across the whole SOC window, the deepest cycle the battery makes in normal use.
pub fn wear_cost(curve: &[(f64, f64)], replace_kwh: f64, window: f64) -> f64 {
    let w = window.clamp(0.01, 1.0);
    replace_kwh / (cycles_at(curve, w) * w).max(1.0)
}

/// Rainflow counter fed one sample at a time. Samples are reduced to reversals (peaks and valleys) on the way in, and each
/// reversal goes on a stack, so a year of samples costs O(n). `cycle(range, count)` gets every full cycle (count 1) as it
/// closes and, at `finish`, the residue as half cycles (count 0.5).
pub struct Rainflow {
    stack: Vec<f64>,
    /// the last sample, which may still turn out to be a reversal, and the direction it moved in (0: none yet)
    cand: f64,
    dir: i8,
    started: bool,
}

impl Default for Rainflow {
    fn default() -> Self { Rainflow { stack: Vec::with_capacity(64), cand: 0.0, dir: 0, started: false } }
}

impl Rainflow {
    pub fn push(&mut self, x: f64, cycle: &mut impl FnMut(f64, f64)) {
        if !self.started { self.started = true; self.cand = x; self.reversal(x, cycle); return; }
        if x == self.cand { return; }
        let d = if x > self.cand { 1 } else { -1 };
        if self.dir != 0 && d != self.dir { let r = self.cand; self.reversal(r, cycle); }
        self.dir = d;
        self.cand = x;
    }

    /// ASTM E1049-85 5.4.4: X is the newest range, Y the one before it. While X >= Y, Y is counted: as a half cycle when it
    /// holds the starting point (its first point is dropped and the start moves on), else as a full cycle (both points dropped).
    fn reversal(&mut self, x: f64, cycle: &mut impl FnMut(f64, f64)) {
        let s = &mut self.stack;
        s.push(x);
        while s.len() >= 3 {
            let n = s.len();
            let (rx, ry) = ((s[n - 1] - s[n - 2]).abs(), (s[n - 2] - s[n - 3]).abs());
            if rx < ry { break; }
            if n == 3 { cycle(ry, 0.5); s.remove(0); } else { cycle(ry, 1.0); s.drain(n - 3..n - 1); }
        }
    }

    /// Ends the series: the last sample is a reversal, and each range left on the stack counts as a half cycle.
    pub fn finish(&mut self, cycle: &mut impl FnMut(f64, f64)) {
        if self.dir != 0 { let r = self.cand; self.reversal(r, cycle); }
        for w in self.stack.windows(2) { cycle((w[1] - w[0]).abs(), 0.5); }
        *self = Rainflow::default();
    }
}

/// The cycles of a whole series as (range, count) in the order they are counted
pub fn rainflow(x: &[f64]) -> Vec<(f64, f64)> {
    let (mut rf, mut out) = (Rainflow::default(), Vec::new());
    let mut f = |r: f64, c: f64| out.push((r, c));
    for &v in x { rf.push(v, &mut f); }
    rf.finish(&mut f);
    out
}

/// Miner's rule over a year: the damage (share of the cycle life used) and the cycles and their mean depth, from the stored
/// energy as a share of nameplate
#[derive(Debug, Clone, Default)]
pub struct Miner {
    pub damage: f64,
    pub cycles: f64,
    pub depth_sum: f64,
}

impl Miner {
    pub fn add(&mut self, curve: &[(f64, f64)], range: f64, count: f64) {
        if range <= 1e-9 { return; }
        let d = range.min(1.0);
        self.damage += count / cycles_at(curve, d);
        self.cycles += count;
        self.depth_sum += count * d;
    }
}

/// Rainflow and Miner's rule over one year: the stored energy of every step goes in, the year's damage, cycles and mean depth
/// come out
pub struct CycleCount<'a> {
    curve: &'a [(f64, f64)],
    rf: Rainflow,
    miner: Miner,
}

impl<'a> CycleCount<'a> {
    pub fn new(curve: &'a [(f64, f64)]) -> Self { CycleCount { curve, rf: Rainflow::default(), miner: Miner::default() } }
    /// The stored energy of a step as a share of nameplate
    pub fn push(&mut self, x: f64) {
        let (c, m) = (self.curve, &mut self.miner);
        self.rf.push(x, &mut |d, n| m.add(c, d, n));
    }
    /// Ends the year: Miner's damage, the cycles and their mean depth of discharge
    pub fn finish(mut self) -> (f64, f64, f64) {
        let (c, m) = (self.curve, &mut self.miner);
        self.rf.finish(&mut |d, n| m.add(c, d, n));
        let m = &self.miner;
        (m.damage, m.cycles, if m.cycles > 0.0 { m.depth_sum / m.cycles } else { 0.0 })
    }
}
