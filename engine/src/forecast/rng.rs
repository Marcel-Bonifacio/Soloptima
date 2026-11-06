//! The random numbers of the C++ forecasters, as libc++ makes them: std::mt19937, normal_distribution (Marsaglia polar method,
//! the second value kept for the next call), uniform_int_distribution (the lowest bits of one draw, rejected until in range)
//! and std::shuffle. Other standard libraries give other sequences; the fixtures come from libc++ (macOS).

/// std::mt19937
pub struct Mt19937 {
    mt: [u32; 624],
    idx: usize,
}

impl Mt19937 {
    pub fn new(seed: u32) -> Mt19937 {
        let mut mt = [0u32; 624];
        mt[0] = seed;
        for i in 1..624 { mt[i] = 1812433253u32.wrapping_mul(mt[i - 1] ^ (mt[i - 1] >> 30)).wrapping_add(i as u32); }
        Mt19937 { mt, idx: 624 }
    }

    pub fn next_u32(&mut self) -> u32 {
        if self.idx >= 624 {
            for i in 0..624 {
                let y = (self.mt[i] & 0x8000_0000) | (self.mt[(i + 1) % 624] & 0x7fff_ffff);
                let mut v = self.mt[(i + 397) % 624] ^ (y >> 1);
                if y & 1 != 0 { v ^= 0x9908_b0df; }
                self.mt[i] = v;
            }
            self.idx = 0;
        }
        let mut y = self.mt[self.idx];
        self.idx += 1;
        y ^= y >> 11;
        y ^= (y << 7) & 0x9d2c_5680;
        y ^= (y << 15) & 0xefc6_0000;
        y ^ (y >> 18)
    }

    /// generate_canonical<double, 53>: two draws
    fn canonical(&mut self) -> f64 {
        let rp = 4294967296.0;
        let mut sp = f64::from(self.next_u32());
        sp += f64::from(self.next_u32()) * rp;
        sp / (rp * rp)
    }

    /// uniform_real_distribution<double>(0, 1): (1 - 0) x + 0 is the canonical value itself
    pub fn uniform(&mut self) -> f64 { self.canonical() }

    /// uniform_int_distribution over [0, n) (n up to 2^32)
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 1 { return 0; }
        let w = 64 - (n - 1).leading_zeros();   // ceil(log2(n))
        assert!(w <= 32, "range too wide");
        let mask = if w == 32 { u64::from(u32::MAX) } else { (1u64 << w) - 1 };
        loop {
            let u = u64::from(self.next_u32()) & mask;
            if u < n { return u; }
        }
    }

    /// std::shuffle
    pub fn shuffle<T>(&mut self, v: &mut [T]) {
        let d = v.len();
        if d <= 1 { return; }
        let (mut first, last, mut dd) = (0, d - 1, d - 1);
        while first < last {
            let i = self.below(dd as u64 + 1) as usize;
            if i != 0 { v.swap(first, first + i); }
            first += 1;
            dd -= 1;
        }
    }
}

/// std::normal_distribution<double>(0, 1)
#[derive(Default)]
pub struct Normal {
    hot: bool,
    v: f64,
}

impl Normal {
    pub fn sample(&mut self, g: &mut Mt19937) -> f64 {
        if self.hot { self.hot = false; return self.v * 1.0 + 0.0; }   // x * stddev + mean, as libc++
        let (mut u, mut v, mut s);
        loop {
            u = 2.0 * g.canonical() + -1.0;
            v = 2.0 * g.canonical() + -1.0;
            s = u * u + v * v;
            if !(s > 1.0 || s == 0.0) { break; }
        }
        let fp = (-2.0 * s.ln() / s).sqrt();
        self.v = v * fp;
        self.hot = true;
        u * fp * 1.0 + 0.0
    }
}
