//! `std::sort` as libc++ (LLVM 17+, the macOS SDK) runs it with a custom comparator: introsort with median-of-three or ninther
//! pivots, insertion sort under 24 elements and the partition that keeps equal elements together. `std::sort` is not stable,
//! so elements that compare equal (agents of the same size in SHO-QAO-GOA) end up in libc++'s order only with this exact port.
//! Not ported: the heap-sort fallback after 2 log2(n) bad pivots in a row; this port keeps sorting by insertion there.

/// Sorts `v` with the strict weak ordering `less`, leaving equal elements where libc++ leaves them
pub(crate) fn sort<T: Clone>(v: &mut [T], less: impl Fn(&T, &T) -> bool) {
    if v.is_empty() { return; }
    let depth = 2 * (usize::BITS - 1 - v.len().leading_zeros()) as i32;
    introsort(v, 0, v.len(), &less, depth, true);
}

fn sort3<T>(v: &mut [T], x: usize, y: usize, z: usize, c: &impl Fn(&T, &T) -> bool) {
    if !c(&v[y], &v[x]) {
        if !c(&v[z], &v[y]) { return; }
        v.swap(y, z);
        if c(&v[y], &v[x]) { v.swap(x, y); }
        return;
    }
    if c(&v[z], &v[y]) { v.swap(x, z); return; }
    v.swap(x, y);
    if c(&v[z], &v[y]) { v.swap(y, z); }
}

fn sort4<T>(v: &mut [T], a: usize, b: usize, cc: usize, d: usize, c: &impl Fn(&T, &T) -> bool) {
    sort3(v, a, b, cc, c);
    if c(&v[d], &v[cc]) {
        v.swap(cc, d);
        if c(&v[cc], &v[b]) {
            v.swap(b, cc);
            if c(&v[b], &v[a]) { v.swap(a, b); }
        }
    }
}

fn sort5<T>(v: &mut [T], a: usize, b: usize, cc: usize, d: usize, e: usize, c: &impl Fn(&T, &T) -> bool) {
    sort4(v, a, b, cc, d, c);
    if c(&v[e], &v[d]) {
        v.swap(d, e);
        if c(&v[d], &v[cc]) {
            v.swap(cc, d);
            if c(&v[cc], &v[b]) {
                v.swap(b, cc);
                if c(&v[b], &v[a]) { v.swap(a, b); }
            }
        }
    }
}

/// Insertion sort of [first, last); `guarded` false relies on an element at first - 1 no greater than any in the range
fn insertion<T: Clone>(v: &mut [T], first: usize, last: usize, c: &impl Fn(&T, &T) -> bool, guarded: bool) {
    if first == last { return; }
    for i in first + 1..last {
        let mut j = i - 1;
        if c(&v[i], &v[j]) {
            let t = v[i].clone();
            let mut k = j;
            j = i;
            loop {
                v[j] = v[k].clone();
                j = k;
                if guarded && j == first { break; }
                k -= 1;
                if !c(&t, &v[k]) { break; }
            }
            v[j] = t;
        }
    }
}

/// Sorts small ranges completely; otherwise insertion sort that gives up after 8 moved elements (false = not done)
fn insertion_incomplete<T: Clone>(v: &mut [T], first: usize, last: usize, c: &impl Fn(&T, &T) -> bool) -> bool {
    match last - first {
        0 | 1 => return true,
        2 => { if c(&v[last - 1], &v[first]) { v.swap(first, last - 1); } return true; }
        3 => { sort3(v, first, first + 1, last - 1, c); return true; }
        4 => { sort4(v, first, first + 1, first + 2, last - 1, c); return true; }
        5 => { sort5(v, first, first + 1, first + 2, first + 3, last - 1, c); return true; }
        _ => {}
    }
    let mut j = first + 2;
    sort3(v, first, first + 1, j, c);
    let mut count = 0;
    let mut i = j + 1;
    while i != last {
        if c(&v[i], &v[j]) {
            let t = v[i].clone();
            let mut k = j;
            j = i;
            loop {
                v[j] = v[k].clone();
                j = k;
                if j == first { break; }
                k -= 1;
                if !c(&t, &v[k]) { break; }
            }
            v[j] = t;
            count += 1;
            if count == 8 { return i + 1 == last; }
        }
        j = i;
        i += 1;
    }
    true
}

/// Partition around v[first]; elements equal to the pivot go right. Returns the pivot's place and whether nothing moved.
fn partition_right<T: Clone>(v: &mut [T], begin: usize, end: usize, c: &impl Fn(&T, &T) -> bool) -> (usize, bool) {
    let pivot = v[begin].clone();
    let (mut first, mut last) = (begin, end);
    loop { first += 1; if !c(&v[first], &pivot) { break; } }
    if begin == first - 1 {
        while first < last { last -= 1; if c(&v[last], &pivot) { break; } }
    } else {
        loop { last -= 1; if c(&v[last], &pivot) { break; } }
    }
    let already = first >= last;
    while first < last {
        v.swap(first, last);
        loop { first += 1; if !c(&v[first], &pivot) { break; } }
        loop { last -= 1; if c(&v[last], &pivot) { break; } }
    }
    let pp = first - 1;
    if begin != pp { v[begin] = v[pp].clone(); }
    v[pp] = pivot;
    (pp, already)
}

/// Partition around v[first] with elements equal to the pivot on the left (the pivot equals the element before the range)
fn partition_left<T: Clone>(v: &mut [T], begin: usize, end: usize, c: &impl Fn(&T, &T) -> bool) -> usize {
    let pivot = v[begin].clone();
    let (mut first, mut last) = (begin, end);
    if c(&pivot, &v[last - 1]) {
        loop { first += 1; if c(&pivot, &v[first]) { break; } }
    } else {
        loop { first += 1; if !(first < last && !c(&pivot, &v[first])) { break; } }
    }
    if first < last {
        loop { last -= 1; if !c(&pivot, &v[last]) { break; } }
    }
    while first < last {
        v.swap(first, last);
        loop { first += 1; if c(&pivot, &v[first]) { break; } }
        loop { last -= 1; if !c(&pivot, &v[last]) { break; } }
    }
    let pp = first - 1;
    if begin != pp { v[begin] = v[pp].clone(); }
    v[pp] = pivot;
    first
}

fn introsort<T: Clone>(v: &mut [T], mut first: usize, mut last: usize, c: &impl Fn(&T, &T) -> bool, mut depth: i32, mut leftmost: bool) {
    loop {
        let len = last - first;
        match len {
            0 | 1 => return,
            2 => { if c(&v[last - 1], &v[first]) { v.swap(first, last - 1); } return; }
            3 => { sort3(v, first, first + 1, last - 1, c); return; }
            4 => { sort4(v, first, first + 1, first + 2, last - 1, c); return; }
            5 => { sort5(v, first, first + 1, first + 2, first + 3, last - 1, c); return; }
            _ => {}
        }
        if len < 24 || depth == 0 {
            insertion(v, first, last, c, leftmost);
            return;
        }
        depth -= 1;
        let half = len / 2;
        if len > 128 {
            sort3(v, first, first + half, last - 1, c);
            sort3(v, first + 1, first + half - 1, last - 2, c);
            sort3(v, first + 2, first + half + 1, last - 3, c);
            sort3(v, first + half - 1, first + half, first + half + 1, c);
            v.swap(first, first + half);
        } else {
            sort3(v, first + half, first, last - 1, c);
        }
        if !leftmost && !c(&v[first - 1], &v[first]) {
            first = partition_left(v, first, last, c);
            continue;
        }
        let (i, already) = partition_right(v, first, last, c);
        if already {
            let fs = insertion_incomplete(v, first, i, c);
            if insertion_incomplete(v, i + 1, last, c) {
                if fs { return; }
                last = i;
                continue;
            } else if fs {
                first = i + 1;
                continue;
            }
        }
        introsort(v, first, i, c, depth, leftmost);
        leftmost = false;
        first = i + 1;
    }
}
