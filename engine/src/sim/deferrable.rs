//! The deferrable load (`DeferrableLoad`) in the dispatch: its window, the energy it still needs and its store. Each day it
//! must draw its daily energy within its window. What it draws beyond that fills the store (up to its size), and a window that
//! closes short takes the rest from the store; what the store cannot give is unserved deferrable energy.
use super::{mn, mx};
use crate::model::DeferrableLoad;

pub(crate) struct Flex<'a> {
    pub d: &'a DeferrableLoad,
    /// energy in the store, and energy drawn in the window now open
    pub tank: f64,
    pub done: f64,
    /// steps per hour
    k: usize,
}

impl<'a> Flex<'a> {
    /// At the start of the simulation (local hour 0): the store at its initial fill, and a window already open counted as
    /// served for the hours it has been open, so the first day asks only for its share
    pub fn new(d: &'a DeferrableLoad, k: usize) -> Flex<'a> {
        let mut f = Flex { d, tank: d.tank_kwh * d.tank_fill, done: 0.0, k };
        if f.in_win(0) { f.done = d.kwh_day * f64::from((24 - d.start_h) % 24) / f64::from(d.window_h()); }
        f
    }

    pub fn in_win(&self, h: usize) -> bool {
        let (h, s, e) = (h as i32, self.d.start_h, self.d.end_h);
        if s == e { true } else if s < e { h >= s && h < e } else { h >= s || h < e }
    }

    /// Hours from the start of hour h (in the window) to the window's end
    pub fn hours_left(&self, h: usize) -> usize {
        let r = (self.d.end_h - h as i32).rem_euclid(24);
        if r == 0 { 24 } else { r as usize }
    }

    /// Energy still needed in the window now open (the store counts)
    pub fn need(&self) -> f64 { mx(0.0, self.d.kwh_day - self.tank - self.done) }

    /// Energy the load can still take in the window: today's need and the room in the store
    pub fn room(&self) -> f64 { mx(0.0, self.d.tank_kwh + self.d.kwh_day - self.tank - self.done) }

    /// The store's level: today's draw goes to today's energy first, the rest to the store
    pub fn level(&self) -> f64 { self.tank + mx(0.0, self.done - self.d.kwh_day) }

    /// At step `sub` of local hour h: a window that ends now closes, its shortfall taken from the store. Returns the energy
    /// neither could give (unserved). `first`: the first step of the simulation, where no window has run yet.
    pub fn close_at(&mut self, h: usize, sub: usize, first: bool) -> f64 {
        if sub != 0 || h as i32 != self.d.end_h || first { return 0.0; }
        let s = self.tank + self.done;
        let short = mx(0.0, self.d.kwh_day - s);
        self.tank = mn(self.d.tank_kwh, mx(0.0, s - self.d.kwh_day));
        self.done = 0.0;
        short
    }

    /// The least power (kW) in step `sub` of hour h for the window to finish at the maximum power: the energy left beyond
    /// what the steps after this one can draw
    pub fn least(&self, h: usize, sub: usize, dt: f64) -> f64 {
        let after = (self.hours_left(h) * self.k - sub - 1) as f64;
        mn(self.d.kw, mx(0.0, self.need() - after * self.d.kw * dt) / dt)
    }

    /// The windows within the next `horizon` hours from hour t, each with its first and end hour in the horizon and the
    /// energy it needs, the store drawn first. A window that ends beyond the horizon is left to a later plan.
    pub fn windows(&self, t: usize, horizon: usize) -> Vec<(usize, usize, f64)> {
        let (mut out, mut s, mut j) = (Vec::new(), self.tank + self.done, 0);
        while j < horizon {
            let h = (t + j) % 24;
            if !self.in_win(h) { j += 1; continue; }
            let end = j + self.hours_left(h);
            if end > horizon { break; }
            out.push((j, end, mx(0.0, self.d.kwh_day - s)));
            s = mx(0.0, s - self.d.kwh_day);
            j = end;
        }
        out
    }
}
