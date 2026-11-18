// The 3D view's shaders (view3d.rs): a depth pass from the sun into the shadow map, then the scene lit by the sun, with a
// 3 x 3 filtered shadow lookup. Faces get their normal from the screen-space change of their position, turned to the camera.
struct U {
  view: mat4x4<f32>,
  light: mat4x4<f32>,
  eye: vec4<f32>,
  sun: vec4<f32>,   // towards the sun; w: 1 with the sun above the horizon
  cells: vec4<f32>,   // solar cells per module along a table and up it
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var smap: texture_depth_2d;
@group(0) @binding(2) var scmp: sampler_comparison;

struct V {
  @builtin(position) pos: vec4<f32>,
  @location(0) wp: vec3<f32>,
  @location(1) col: vec4<f32>,
  @location(2) uv: vec2<f32>,
};

@vertex fn vs(@location(0) p: vec3<f32>, @location(1) t: vec2<f32>, @location(2) c: vec4<f32>) -> V {
  var o: V;
  o.pos = u.view * vec4<f32>(p, 1.0);
  o.wp = p;
  o.col = c;
  o.uv = t;
  return o;
}

@vertex fn vs_shadow(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> {
  return u.light * vec4<f32>(p, 1.0);
}

// share of the sun reaching a point: 1 lit, 0 in shadow
fn sunlit(wp: vec3<f32>) -> f32 {
  let l = u.light * vec4<f32>(wp, 1.0);
  let uv = vec2<f32>(l.x * 0.5 + 0.5, 0.5 - l.y * 0.5);
  if (any(uv < vec2<f32>(0.0)) || any(uv > vec2<f32>(1.0))) { return 1.0; }
  let t = 1.0 / f32(textureDimensions(smap).x);
  var s = 0.0;
  for (var i = -1; i <= 1; i++) {
    for (var j = -1; j <= 1; j++) {
      s += textureSampleCompareLevel(smap, scmp, uv + vec2<f32>(f32(i), f32(j)) * t, l.z - 0.0002);
    }
  }
  return s / 9.0;
}

// how far (in pixels) a point is from the nearest grid line of spacing 1 in g
fn grid(g: vec2<f32>) -> f32 {
  let d = abs(fract(g - 0.5) - 0.5) / max(fwidth(g), vec2<f32>(1e-5));
  return min(d.x, d.y);
}

fn hash3(p: vec3<f32>) -> f32 { return fract(sin(dot(p, vec3<f32>(12.9898, 78.233, 37.719))) * 43758.5453); }

// the colour flag in alpha (lib/layout/scene.js, MESH_FLAG): 255 solid, 200 panel, 150 glass, 100 leaves, 0 a line
@fragment fn fs(v: V) -> @location(0) vec4<f32> {
  let flag = round(v.col.a * 255.0);
  var n = normalize(cross(dpdx(v.wp), dpdy(v.wp)));
  if (dot(n, u.eye.xyz - v.wp) < 0.0) { n = -n; }
  // derivatives first, while every pixel of the quad runs the same code
  let cells = v.uv * u.cells.xy;
  let cell_px = max(fwidth(cells).x, fwidth(cells).y);
  let cell_line = 1.0 - min(grid(cells), 1.0);
  let module_line = 1.0 - min(grid(v.uv) / 1.5, 1.0);
  if (flag < 0.5) { return vec4<f32>(v.col.rgb, 1.0); }   // cable routes and struts keep their colour
  // the shadow map only by day: lines and night frames skip its nine samples
  var lit = 1.0;
  var k = 0.5;
  if (u.sun.w > 0.5) {
    lit = sunlit(v.wp);
    k = 0.55 + 0.45 * max(dot(n, u.sun.xyz), 0.0) * lit;
  }
  var col = v.col.rgb;
  let view = normalize(u.eye.xyz - v.wp);
  if (abs(flag - 200.0) < 1.0) {
    // a table: cells, module frames, and from behind the backsheet (the side facing down)
    let up = select(-n, n, n.z >= 0.0);
    if (dot(up, view) < 0.0 && abs(up.z) > 0.02) { return vec4<f32>(vec3<f32>(0.78, 0.77, 0.73) * k, 1.0); }
    let fade = 1.0 - smoothstep(0.15, 0.45, cell_px);
    col = mix(col, vec3<f32>(0.30, 0.44, 0.62), cell_line * 0.45 * fade);
    col = mix(col, vec3<f32>(0.80, 0.80, 0.78), module_line);
  }
  if (abs(flag - 100.0) < 1.0) { k = k * (0.84 + 0.3 * hash3(floor(v.wp * 1.5))); }
  col = col * k;
  if ((abs(flag - 200.0) < 1.0 || abs(flag - 150.0) < 1.0) && u.sun.w > 0.5) {
    let spec = pow(max(dot(reflect(-u.sun.xyz, n), view), 0.0), 40.0) * 0.6 * lit;
    col = mix(col, vec3<f32>(0.92, 0.95, 1.0), spec);
  }
  return vec4<f32>(col, 1.0);
}
