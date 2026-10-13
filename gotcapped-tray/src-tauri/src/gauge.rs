// Tray icon: a small fuel gauge (half-ring) whose needle/fill tracks the active plan's weekly bar %.
// Drawn in code so it updates live; template-style monochrome on macOS, accent past 70%, red past 90%.
pub fn render(pct: Option<f64>, size: u32, template: bool) -> Vec<u8> {
    let s = size as f64;
    let mut px = vec![0u8; (size * size * 4) as usize];
    let (cx, cy) = (s / 2.0, s * 0.70);
    let (r_out, r_in) = (s * 0.46, s * 0.30);
    let p = pct.unwrap_or(0.0).clamp(0.0, 100.0) / 100.0;
    let ink = [20u8, 20, 18];
    let fill = if template { ink } else if p >= 0.9 { [229, 72, 77] } else if p >= 0.7 { [255, 90, 31] } else { ink };
    let faint: u8 = if template { 90 } else { 70 };
    for y in 0..size {
        for x in 0..size {
            // 3x3 supersampling for smooth edges at 16-22 px.
            let (mut a_track, mut a_fill, mut a_needle) = (0.0, 0.0, 0.0);
            for sy in 0..3 { for sx in 0..3 {
                let fx = x as f64 + (sx as f64 + 0.5) / 3.0; let fy = y as f64 + (sy as f64 + 0.5) / 3.0;
                let (dx, dy) = (fx - cx, cy - fy); let d = (dx * dx + dy * dy).sqrt();
                let ang = dy.atan2(dx); // 0..PI across the top
                if d <= r_out && d >= r_in && dy >= -s * 0.02 {
                    let t = 1.0 - (ang / std::f64::consts::PI).clamp(0.0, 1.0); // 0 at left, 1 at right
                    if pct.is_some() && t <= p { a_fill += 1.0 } else { a_track += 1.0 }
                }
                // needle hub
                if d <= s * 0.09 { a_needle += 1.0 }
                // needle
                if pct.is_some() {
                    let na = std::f64::consts::PI * (1.0 - p);
                    let (ux, uy) = (na.cos(), na.sin());
                    let along = dx * ux + dy * uy; let perp = (dx * uy - dy * ux).abs();
                    if along >= 0.0 && along <= r_in * 0.95 && perp <= s * 0.045 { a_needle += 1.0 }
                }
            }}
            let i = ((y * size + x) * 4) as usize;
            let (a_track, a_fill, a_needle) = (a_track / 9.0, a_fill / 9.0, (a_needle as f64 / 9.0_f64).min(1.0));
            let (col, a) = if a_needle > 0.0 { (ink, a_needle * 255.0) } else if a_fill > 0.0 { (fill, a_fill * 255.0) } else { (ink, a_track * faint as f64) };
            if a > 0.0 { px[i] = col[0]; px[i + 1] = col[1]; px[i + 2] = col[2]; px[i + 3] = a.round() as u8; }
        }
    }
    px
}

#[cfg(test)]
mod tests {
    #[test]
    fn gauge_fills_with_pct() {
        let empty = super::render(None, 44, false); let full = super::render(Some(95.0), 44, false);
        let opaque = |v: &Vec<u8>| v.chunks(4).filter(|p| p[3] > 200).count();
        assert!(opaque(&full) > opaque(&empty));
        // red past 90%
        assert!(full.chunks(4).any(|p| p[3] > 200 && p[0] == 229 && p[1] == 72));
        if let Ok(d) = std::env::var("GAUGE_OUT") { for p in [0.0, 41.0, 75.0, 95.0] { std::fs::write(format!("{d}/gauge-{p}.rgba"), super::render(Some(p), 44, false)).unwrap(); } }
    }
}
