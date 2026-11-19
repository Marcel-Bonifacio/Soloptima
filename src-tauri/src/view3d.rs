//! The 3D view of the Site & layout page drawn on the GPU with wgpu: Metal on macOS, Direct3D 12 on Windows, Vulkan on Linux.
//! The page sends the scene as a mesh (ui/src/lib/layout/scene.js, meshOf) and asks for frames of a camera and a sun; each
//! frame is drawn off screen (a shadow map from the sun, then the scene with 4x multisampling) and answered as RGBA pixels the
//! page puts on its canvas. Tauri gives the shell no pointer events, so the page keeps the input and the picking.
//! Under the scene the page can lay the satellite image of the site (view3d_ground): a flat textured quad, drawn with the
//! sun's shadows on it.
use soloptima_engine::api::ApiError;
use std::sync::{mpsc, Mutex};
use tauri::ipc::{InvokeBody, Request, Response};
use wgpu::util::DeviceExt;

const SHADOW: u32 = 4096;
const MSAA: u32 = 4;
/// bytes of a mesh corner: x, y, z, u, v as f32, then r, g, b and how the sun lights it
const CORNER: usize = 24;
const UNIFORMS: u64 = 176;
const MAX_SIDE: u32 = 4096;
/// pixels of a frame at most: the page asks for up to 2.5 million; 4x multisampled targets of this size hold about 135 MB
const MAX_PIXELS: u32 = 4_200_000;
/// near plane of the camera, m (reversed depth: near is 1, infinitely far is 0)
const NEAR: f64 = 0.1;
/// pixels of the ground image along a side at most (the page asks for up to 2048)
pub const MAX_GROUND: u32 = 2048;
/// bytes before the pixels of a ground image: its width and height as u32, then four corners x, y, z as f32
const GROUND_HEAD: usize = 56;

struct Scene {
    tris: Option<wgpu::Buffer>,
    n_tri: u32,
    lines: Option<wgpu::Buffer>,
    n_line: u32,
    radius: f64,
}

struct Targets {
    w: u32,
    h: u32,
    colour: wgpu::TextureView,
    depth: wgpu::TextureView,
    resolve: wgpu::Texture,
    resolve_view: wgpu::TextureView,
    read: wgpu::Buffer,
    row: u32,
}

struct Gpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    backend: &'static str,
    tri: wgpu::RenderPipeline,
    line: wgpu::RenderPipeline,
    shadow: wgpu::RenderPipeline,
    ground: wgpu::RenderPipeline,
    ground_bgl: wgpu::BindGroupLayout,
    ground_sampler: wgpu::Sampler,
    /// the satellite image under the scene and the quad it lies on; drawn when both are there
    ground_tex: Option<wgpu::BindGroup>,
    ground_quad: Option<wgpu::Buffer>,
    uniforms: wgpu::Buffer,
    main: wgpu::BindGroup,
    light: wgpu::BindGroup,
    smap: wgpu::TextureView,
    scene: Option<Scene>,
    /// the item being dragged in the 3D view, drawn with the scene (which then leaves it out)
    moving: Option<Scene>,
    /// what the shadow map holds: the sun and the meshes' version it was drawn for
    shadow_key: Option<([u32; 3], u64)>,
    rev: u64,
    targets: Option<Targets>,
}

/// The GPU, set up on the first call; an adapter that cannot be had stays an error, so the page falls back to its own drawing
static GPU: Mutex<Option<Result<Gpu, String>>> = Mutex::new(None);

fn init() -> Result<Gpu, String> {
    let mut desc = wgpu::InstanceDescriptor::new_without_display_handle();
    desc.backends = wgpu::Backends::PRIMARY;
    let instance = wgpu::Instance::new(desc);
    let adapter = tauri::async_runtime::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
        .map_err(|e| format!("No graphics adapter for the 3D view: {e}"))?;
    let backend = match adapter.get_info().backend {
        wgpu::Backend::Metal => "Metal",
        wgpu::Backend::Dx12 => "Direct3D 12",
        wgpu::Backend::Vulkan => "Vulkan",
        _ => "GPU",
    };
    let (device, queue) = tauri::async_runtime::block_on(adapter.request_device(&wgpu::DeviceDescriptor { label: Some("view3d"), ..Default::default() }))
        .map_err(|e| format!("The graphics adapter cannot draw the 3D view: {e}"))?;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("view3d"), source: wgpu::ShaderSource::Wgsl(include_str!("view3d.wgsl").into()) });

    let entry = |binding, visibility, ty| wgpu::BindGroupLayoutEntry { binding, visibility, ty, count: None };
    let ubuf = wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: None };
    let main_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[
        entry(0, wgpu::ShaderStages::VERTEX_FRAGMENT, ubuf),
        entry(1, wgpu::ShaderStages::FRAGMENT, wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }),
        entry(2, wgpu::ShaderStages::FRAGMENT, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Comparison)),
    ]});
    let ground_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[
        entry(0, wgpu::ShaderStages::FRAGMENT, wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false }),
        entry(1, wgpu::ShaderStages::FRAGMENT, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
    ]});
    let light_bgl = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: None, entries: &[entry(0, wgpu::ShaderStages::VERTEX, ubuf)] });
    let layout = |bgl: &wgpu::BindGroupLayout| device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(bgl)], immediate_size: 0 });
    let (main_layout, light_layout) = (layout(&main_bgl), layout(&light_bgl));

    let attrs = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x2, 2 => Unorm8x4];
    let colour = [Some(wgpu::ColorTargetState::from(wgpu::TextureFormat::Rgba8Unorm))];
    let corners = [Some(wgpu::VertexBufferLayout { array_stride: CORNER as u64, step_mode: wgpu::VertexStepMode::Vertex, attributes: &attrs })];
    let depth = |compare, bias| wgpu::DepthStencilState { format: wgpu::TextureFormat::Depth32Float, depth_write_enabled: Some(true), depth_compare: Some(compare), stencil: Default::default(), bias };
    let pipe = |layout, vs, fs: Option<&str>, topology, depth, count| device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: None,
        layout: Some(layout),
        vertex: wgpu::VertexState { module: &module, entry_point: Some(vs), compilation_options: Default::default(), buffers: &corners },
        primitive: wgpu::PrimitiveState { topology, ..Default::default() },
        depth_stencil: Some(depth),
        multisample: wgpu::MultisampleState { count, ..Default::default() },
        fragment: fs.map(|fs| wgpu::FragmentState { module: &module, entry_point: Some(fs), compilation_options: Default::default(), targets: &colour }),
        multiview_mask: None,
        cache: None,
    });
    let tri = pipe(&main_layout, "vs", Some("fs"), wgpu::PrimitiveTopology::TriangleList, depth(wgpu::CompareFunction::Greater, Default::default()), MSAA);
    let line = pipe(&main_layout, "vs", Some("fs"), wgpu::PrimitiveTopology::LineList, depth(wgpu::CompareFunction::GreaterEqual, Default::default()), MSAA);
    let shadow = pipe(&light_layout, "vs_shadow", None, wgpu::PrimitiveTopology::TriangleList,
        depth(wgpu::CompareFunction::Less, wgpu::DepthBiasState { constant: 2, slope_scale: 2.0, clamp: 0.0 }), 1);
    // the ground image: corners of x, y, z and the image's u, v as f32, lit like the scene and shadowed by it
    let ground_attrs = wgpu::vertex_attr_array![0 => Float32x3, 1 => Float32x2];
    let ground = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("ground"),
        layout: Some(&device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor { label: None, bind_group_layouts: &[Some(&main_bgl), Some(&ground_bgl)], immediate_size: 0 })),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_ground"), compilation_options: Default::default(),
            buffers: &[Some(wgpu::VertexBufferLayout { array_stride: 20, step_mode: wgpu::VertexStepMode::Vertex, attributes: &ground_attrs })] },
        primitive: wgpu::PrimitiveState { topology: wgpu::PrimitiveTopology::TriangleList, ..Default::default() },
        depth_stencil: Some(depth(wgpu::CompareFunction::Greater, Default::default())),
        multisample: wgpu::MultisampleState { count: MSAA, ..Default::default() },
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_ground"), compilation_options: Default::default(), targets: &colour }),
        multiview_mask: None,
        cache: None,
    });
    let ground_sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, mipmap_filter: wgpu::MipmapFilterMode::Linear, anisotropy_clamp: 8, ..Default::default()
    });

    let smap = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("shadow map"), size: wgpu::Extent3d { width: SHADOW, height: SHADOW, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count: 1,
        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING, view_formats: &[],
    }).create_view(&Default::default());
    let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
        mag_filter: wgpu::FilterMode::Linear, min_filter: wgpu::FilterMode::Linear, compare: Some(wgpu::CompareFunction::LessEqual), ..Default::default()
    });
    let uniforms = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: UNIFORMS, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let main = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &main_bgl, entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&smap) },
        wgpu::BindGroupEntry { binding: 2, resource: wgpu::BindingResource::Sampler(&sampler) },
    ]});
    let light = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &light_bgl,
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: uniforms.as_entire_binding() }] });
    Ok(Gpu { device, queue, backend, tri, line, shadow, ground, ground_bgl, ground_sampler, ground_tex: None, ground_quad: None, uniforms, main, light, smap, scene: None, moving: None, shadow_key: None, rev: 0, targets: None })
}

/// The mesh of meshOf: a u32 count of triangle corners and the f32 radius of the scene, then the corners (triangles, then
/// line ends). An empty body clears it. `moving`: the mesh of the item being dragged, else the scene.
fn set_scene(g: &mut Gpu, b: &[u8], moving: bool) -> Result<(), String> {
    g.rev += 1;
    if !moving { g.moving = None; }   // a new scene holds every item again
    if b.is_empty() { if moving { g.moving = None } else { g.scene = None } return Ok(()); }
    let bad = || "The 3D view was sent a mesh it cannot read.".to_string();
    if b.len() < 8 || !(b.len() - 8).is_multiple_of(CORNER) { return Err(bad()); }
    let n_tri = u32::from_le_bytes(b[0..4].try_into().unwrap()) as usize;
    let radius = f32::from_le_bytes(b[4..8].try_into().unwrap()) as f64;
    let all = (b.len() - 8) / CORNER;
    if n_tri > all || !n_tri.is_multiple_of(3) || !(all - n_tri).is_multiple_of(2) || !(radius.is_finite() && radius > 0.0) { return Err(bad()); }
    let buf = |bytes: &[u8]| (!bytes.is_empty()).then(|| g.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: None, contents: bytes, usage: wgpu::BufferUsages::VERTEX }));
    let split = 8 + n_tri * CORNER;
    let m = Some(Scene { tris: buf(&b[8..split]), n_tri: n_tri as u32, lines: buf(&b[split..]), n_line: (all - n_tri) as u32, radius });
    if moving { g.moving = m } else { g.scene = m }
    Ok(())
}

/// The ground image: a u32 width and height, the corners of the quad it lies on as x, y, z f32 (south-west, south-east,
/// north-east, north-west: the image's bottom left, bottom right, top right and top left), then width x height RGBA pixels,
/// rows from the top. Width and height 0 with no pixels move the quad and keep the image. An empty body clears it.
fn set_ground(g: &mut Gpu, b: &[u8]) -> Result<(), String> {
    if b.is_empty() { g.ground_tex = None; g.ground_quad = None; return Ok(()); }
    let bad = || "The 3D view was sent a ground image it cannot read.".to_string();
    if b.len() < GROUND_HEAD { return Err(bad()); }
    let (w, h) = (u32::from_le_bytes(b[0..4].try_into().unwrap()), u32::from_le_bytes(b[4..8].try_into().unwrap()));
    let c: Vec<f32> = b[8..GROUND_HEAD].as_chunks::<4>().0.iter().map(|x| f32::from_le_bytes(*x)).collect();
    if !c.iter().all(|x| x.is_finite() && x.abs() < 1e7) { return Err(bad()); }
    let px = &b[GROUND_HEAD..];
    let keep = w == 0 && h == 0 && px.is_empty();
    if !keep && (!(1..=MAX_GROUND).contains(&w) || !(1..=MAX_GROUND).contains(&h) || px.len() != (w * h * 4) as usize) { return Err(bad()); }
    let mut quad = Vec::with_capacity(6 * 20);
    for i in [0, 1, 2, 0, 2, 3] {
        let uv = [[0.0f32, 1.0], [1.0, 1.0], [1.0, 0.0], [0.0, 0.0]][i];
        for x in [c[3 * i], c[3 * i + 1], c[3 * i + 2], uv[0], uv[1]] { quad.extend_from_slice(&x.to_le_bytes()); }
    }
    g.ground_quad = Some(g.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some("ground quad"), contents: &quad, usage: wgpu::BufferUsages::VERTEX }));
    if keep { return Ok(()); }
    // mip levels averaged here, 2 x 2 pixels to 1, so the image stays calm when seen from far
    let levels = 32 - w.max(h).leading_zeros();
    let tex = g.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("ground"), size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: levels, sample_count: 1,
        dimension: wgpu::TextureDimension::D2, format: wgpu::TextureFormat::Rgba8Unorm,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST, view_formats: &[],
    });
    let (mut cur, mut cw, mut ch) = (px.to_vec(), w, h);
    for level in 0..levels {
        g.queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &tex, mip_level: level, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &cur,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(cw * 4), rows_per_image: Some(ch) },
            wgpu::Extent3d { width: cw, height: ch, depth_or_array_layers: 1 },
        );
        if level + 1 == levels { break; }
        let (nw, nh) = ((cw / 2).max(1), (ch / 2).max(1));
        let mut next = vec![0u8; (nw * nh * 4) as usize];
        let at = |x: u32, y: u32, k: u32| cur[((y.min(ch - 1) * cw + x.min(cw - 1)) * 4 + k) as usize] as u32;
        for y in 0..nh { for x in 0..nw { for k in 0..4 {
            let s = at(2 * x, 2 * y, k) + at(2 * x + 1, 2 * y, k) + at(2 * x, 2 * y + 1, k) + at(2 * x + 1, 2 * y + 1, k);
            next[((y * nw + x) * 4 + k) as usize] = s.div_ceil(4).min(255) as u8;
        } } }
        (cur, cw, ch) = (next, nw, nh);
    }
    let view = tex.create_view(&Default::default());
    g.ground_tex = Some(g.device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &g.ground_bgl, entries: &[
        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
        wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::Sampler(&g.ground_sampler) },
    ]}));
    Ok(())
}

type V3 = [f64; 3];
fn sub(a: V3, b: V3) -> V3 { [a[0] - b[0], a[1] - b[1], a[2] - b[2]] }
fn dot(a: V3, b: V3) -> f64 { a[0] * b[0] + a[1] * b[1] + a[2] * b[2] }
fn cross(a: V3, b: V3) -> V3 { [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]] }
fn unit(v: V3) -> V3 { let n = dot(v, v).sqrt().max(1e-12); [v[0] / n, v[1] / n, v[2] / n] }
fn row(v: V3, k: f64, w: f64) -> [f64; 4] { [v[0] * k, v[1] * k, v[2] * k, w] }

/// What a frame shows: its size in pixels, the camera (as cameraOf in scene.js: turned to azimuth `az`, `el` above the horizon,
/// at `dist` from the point it looks at, `target`) and the unit vector towards the sun
pub struct View { pub w: u32, pub h: u32, pub az: f64, pub el: f64, pub dist: f64, pub target: V3, pub sun: V3, pub day: bool, pub cells: [f64; 2] }

/// The camera of cameraOf as a matrix (rows), with reversed depth to infinity; and the eye
fn camera(v: &View) -> ([[f64; 4]; 4], V3) {
    let r = std::f64::consts::PI / 180.0;
    let t = v.target;
    let eye = [t[0] + v.dist * (v.el * r).cos() * (v.az * r).sin(), t[1] + v.dist * (v.el * r).cos() * (v.az * r).cos(), t[2] + v.dist * (v.el * r).sin()];
    let fwd = unit(sub(t, eye));
    let right = unit(cross(fwd, [0.0, 0.0, 1.0]));
    let up = cross(right, fwd);
    let f = 0.9 * v.w.min(v.h) as f64;
    let (kx, ky) = (2.0 * f / v.w as f64, 2.0 * f / v.h as f64);
    ([row(right, kx, -kx * dot(right, eye)), row(up, ky, -ky * dot(up, eye)), [0.0, 0.0, 0.0, NEAR], row(fwd, 1.0, -dot(fwd, eye))], eye)
}

/// The sun's view of a sphere of `radius` round the centre: x and y across its beam, depth along it (0 nearest the sun)
fn light(sun: V3, radius: f64) -> [[f64; 4]; 4] {
    let lf = unit([-sun[0], -sun[1], -sun[2]]);
    let lr = unit(cross(lf, if lf[2].abs() > 0.999 { [0.0, 1.0, 0.0] } else { [0.0, 0.0, 1.0] }));
    let lu = cross(lr, lf);
    [row(lr, 1.0 / radius, 0.0), row(lu, 1.0 / radius, 0.0), row(lf, 0.5 / radius, 0.5), [0.0, 0.0, 0.0, 1.0]]
}

fn targets(d: &wgpu::Device, w: u32, h: u32) -> Targets {
    let tex = |format, sample_count, usage| d.create_texture(&wgpu::TextureDescriptor {
        label: None, size: wgpu::Extent3d { width: w, height: h, depth_or_array_layers: 1 }, mip_level_count: 1, sample_count,
        dimension: wgpu::TextureDimension::D2, format, usage, view_formats: &[],
    });
    let att = wgpu::TextureUsages::RENDER_ATTACHMENT;
    let resolve = tex(wgpu::TextureFormat::Rgba8Unorm, 1, att | wgpu::TextureUsages::COPY_SRC);
    let row = (w * 4).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    Targets {
        w, h, row,
        colour: tex(wgpu::TextureFormat::Rgba8Unorm, MSAA, att).create_view(&Default::default()),
        depth: tex(wgpu::TextureFormat::Depth32Float, MSAA, att).create_view(&Default::default()),
        resolve_view: resolve.create_view(&Default::default()),
        resolve,
        read: d.create_buffer(&wgpu::BufferDescriptor { label: None, size: (row * h) as u64, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false }),
    }
}

/// A frame as RGBA pixels, rows from the top
fn render(g: &mut Gpu, v: &View) -> Result<Vec<u8>, String> {
    if !(1..=MAX_SIDE).contains(&v.w) || !(1..=MAX_SIDE).contains(&v.h) || v.w * v.h > MAX_PIXELS || ![v.az, v.el, v.dist, v.sun[0], v.sun[1], v.sun[2], v.cells[0], v.cells[1], v.target[0], v.target[1], v.target[2]].iter().all(|x| x.is_finite()) || v.dist <= 0.0 {
        return Err("The 3D view asked for a frame it cannot draw.".into());
    }
    if g.targets.as_ref().is_none_or(|t| t.w != v.w || t.h != v.h) { g.targets = Some(targets(&g.device, v.w, v.h)); }
    let (t, s) = (g.targets.as_ref().unwrap(), g.scene.as_ref());
    let parts: Vec<&Scene> = [g.scene.as_ref(), g.moving.as_ref()].into_iter().flatten().collect();
    let (view, eye) = camera(v);
    let lit = v.day && s.is_some();
    // the shadow map is drawn again only when the sun or a mesh changed, not for every turn of the camera
    let key = ([v.sun[0] as f32, v.sun[1] as f32, v.sun[2] as f32].map(f32::to_bits), g.rev);
    let shadows = lit && g.shadow_key != Some(key);
    let mut u = Vec::with_capacity(UNIFORMS as usize);
    for m in [view, light(v.sun, s.map_or(1.0, |s| s.radius))] {
        for c in 0..4 { for r in m { u.extend_from_slice(&(r[c] as f32).to_le_bytes()); } }   // columns, as WGSL reads a mat4x4
    }
    for x in [eye[0], eye[1], eye[2], 1.0, v.sun[0], v.sun[1], v.sun[2], if lit { 1.0 } else { 0.0 }, v.cells[0].clamp(1.0, 50.0), v.cells[1].clamp(1.0, 50.0), 0.0, 0.0] { u.extend_from_slice(&(x as f32).to_le_bytes()); }
    g.queue.write_buffer(&g.uniforms, 0, &u);

    let mut enc = g.device.create_command_encoder(&Default::default());
    if shadows {
        let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &g.smap,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(1.0), store: wgpu::StoreOp::Store }), stencil_ops: None }),
            ..Default::default()
        });
        p.set_pipeline(&g.shadow);
        p.set_bind_group(0, &g.light, &[]);
        for Scene { tris, n_tri, .. } in &parts {
            let Some(b) = tris else { continue };
            p.set_vertex_buffer(0, b.slice(..));
            p.draw(0..*n_tri, 0..1);
        }
    }
    {
        let sky = if v.day { [188.0, 216.0, 238.0] } else { [74.0, 85.0, 102.0] };
        let mut p = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            color_attachments: &[Some(wgpu::RenderPassColorAttachment { view: &t.colour, depth_slice: None, resolve_target: Some(&t.resolve_view),
                ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color { r: sky[0] / 255.0, g: sky[1] / 255.0, b: sky[2] / 255.0, a: 1.0 }), store: wgpu::StoreOp::Discard } })],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment { view: &t.depth,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Discard }), stencil_ops: None }),
            ..Default::default()
        });
        p.set_bind_group(0, &g.main, &[]);
        if let (Some(tex), Some(quad)) = (&g.ground_tex, &g.ground_quad) {
            p.set_pipeline(&g.ground);
            p.set_bind_group(1, tex, &[]);
            p.set_vertex_buffer(0, quad.slice(..));
            p.draw(0..6, 0..1);
        }
        for s in &parts {
            for (pipe, buf, n) in [(&g.tri, &s.tris, s.n_tri), (&g.line, &s.lines, s.n_line)] {
                let Some(b) = buf else { continue };
                p.set_pipeline(pipe);
                p.set_vertex_buffer(0, b.slice(..));
                p.draw(0..n, 0..1);
            }
        }
    }
    enc.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture: &t.resolve, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &t.read, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(t.row), rows_per_image: Some(t.h) } },
        wgpu::Extent3d { width: t.w, height: t.h, depth_or_array_layers: 1 },
    );
    g.queue.submit([enc.finish()]);
    if shadows { g.shadow_key = Some(key); }
    let slice = t.read.slice(..);
    let (tx, rx) = mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |r| { let _ = tx.send(r); });
    g.device.poll(wgpu::PollType::wait_indefinitely()).map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity((t.w * t.h * 4) as usize);
    {
        let data = slice.get_mapped_range().map_err(|e| e.to_string())?;
        if t.row == t.w * 4 { out.extend_from_slice(&data[..(t.row * t.h) as usize]); }
        else { for y in 0..t.h as usize { let a = y * t.row as usize; out.extend_from_slice(&data[a..a + t.w as usize * 4]); } }
    }
    t.read.unmap();
    Ok(out)
}

/// Runs `f` on the GPU in a blocking thread, setting it up the first time. A panic in it (wgpu reports a lost device or a
/// validation error that way) drops the GPU, so the next call sets it up afresh rather than drawing with a broken one.
async fn on_gpu<T: Send + 'static>(f: impl FnOnce(&mut Gpu) -> Result<T, String> + Send + 'static) -> Result<T, ApiError> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut lock = GPU.lock().unwrap_or_else(|p| p.into_inner());
        let g = lock.get_or_insert_with(init).as_mut().map_err(|e| ApiError::new(e.clone()))?;
        match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| f(g))) {
            Ok(r) => r.map_err(ApiError::new),
            Err(_) => { *lock = None; Err(ApiError::internal("The 3D view's graphics device failed; it starts again on the next frame.")) }
        }
    })
    .await
    .map_err(|e| ApiError::internal(format!("The 3D view failed: {e}")))?
}

/// The scene's mesh as the request body; answers the graphics API that draws it (Metal, Direct3D 12, Vulkan)
#[tauri::command]
pub async fn view3d_scene(request: Request<'_>) -> Result<String, ApiError> {
    let InvokeBody::Raw(data) = request.body() else { return Err(ApiError::internal("No mesh was sent.")) };
    let data = data.clone();
    on_gpu(move |g| { set_scene(g, &data, false)?; Ok(g.backend.to_string()) }).await
}

/// The mesh of the item being dragged as the request body (empty when the drag ends): drawn with the scene, so a drag sends
/// only the item, not the whole plant
#[tauri::command]
pub async fn view3d_moving(request: Request<'_>) -> Result<(), ApiError> {
    let InvokeBody::Raw(data) = request.body() else { return Err(ApiError::internal("No mesh was sent.")) };
    let data = data.clone();
    on_gpu(move |g| set_scene(g, &data, true)).await
}

/// The satellite image under the scene as the request body (see set_ground); empty clears it
#[tauri::command]
pub async fn view3d_ground(request: Request<'_>) -> Result<(), ApiError> {
    let InvokeBody::Raw(data) = request.body() else { return Err(ApiError::internal("No ground image was sent.")) };
    let data = data.clone();
    on_gpu(move |g| set_ground(g, &data)).await
}

/// A frame of the scene: w x h RGBA pixels as raw bytes
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn view3d_frame(w: u32, h: u32, az: f64, el: f64, dist: f64, target: [f64; 3], sun: [f64; 3], day: bool, cells: [f64; 2]) -> Result<Response, ApiError> {
    on_gpu(move |g| render(g, &View { w, h, az, el, dist, target, sun, day, cells })).await.map(Response::new)
}

#[cfg(test)]
mod tests {
    use super::*;

    // the shader reads the same surface flags meshOf writes (MESH_FLAG in ui/src/lib/layout/scene.js)
    #[test]
    fn mesh_flags_match_the_page() {
        let (js, wgsl) = (include_str!("../../ui/src/lib/layout/scene.js"), include_str!("view3d.wgsl"));
        let line = js.lines().find(|l| l.contains("export const MESH_FLAG")).expect("MESH_FLAG in scene.js");
        for (name, v) in [("solid", 255), ("panel", 200), ("glass", 150), ("leaf", 100), ("line", 0)] {
            assert!(line.contains(&format!("{name}: {v}")), "MESH_FLAG.{name} is {v}");
        }
        for v in ["200.0", "150.0", "100.0", "flag < 0.5"] { assert!(wgsl.contains(v), "the shader tests {v}"); }
    }

    // the camera matrix puts a point where cameraOf in scene.js draws it
    #[test]
    fn camera_matches_scene_js() {
        let v = View { w: 800, h: 600, az: 200.0, el: 35.0, dist: 120.0, target: [0.0; 3], sun: [0.0, 0.0, 1.0], day: true, cells: [6.0, 12.0] };
        let (m, eye) = camera(&v);
        let p = [12.0, -7.0, 3.0];
        let c: Vec<f64> = m.iter().map(|r| r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]).collect();
        let (x, y) = ((c[0] / c[3] + 1.0) * 400.0, (1.0 - c[1] / c[3]) * 300.0);
        // cameraOf: x = w/2 + f (d . right) / z, y = h/2 - f (d . up) / z
        let fwd = unit(sub(v.target, eye));
        let right = unit(cross(fwd, [0.0, 0.0, 1.0]));
        let (up, d) = (cross(right, fwd), sub(p, eye));
        let z = dot(d, fwd);
        assert!((x - (400.0 + 540.0 * dot(d, right) / z)).abs() < 1e-9);
        assert!((y - (300.0 - 540.0 * dot(d, up) / z)).abs() < 1e-9);
        assert!(c[2] / c[3] > 0.0 && c[2] / c[3] < 1.0);
    }

    // the sun's view keeps the scene sphere inside its box and puts the side towards the sun nearest
    #[test]
    fn light_box_holds_the_scene() {
        let sun = unit([0.3, -0.5, 0.8]);
        let m = light(sun, 50.0);
        let at = |p: V3| -> Vec<f64> { m.iter().map(|r| r[0] * p[0] + r[1] * p[1] + r[2] * p[2] + r[3]).collect() };
        let (near, far) = (at([sun[0] * 50.0, sun[1] * 50.0, sun[2] * 50.0]), at([-sun[0] * 50.0, -sun[1] * 50.0, -sun[2] * 50.0]));
        assert!(near[2].abs() < 1e-9 && (far[2] - 1.0).abs() < 1e-9);
        assert!(at([0.0, 50.0, 0.0])[..2].iter().all(|x| x.abs() <= 1.0 + 1e-9));
    }

    // a red box on grey ground under a high sun draws on the GPU: sky in the corner, the box lit in the middle, its shadow
    // darker than the open ground; skipped on a machine without a graphics adapter
    #[test]
    fn draws_a_box_and_its_shadow() {
        let Ok(mut g) = init() else { eprintln!("no graphics adapter: skipped"); return };
        let mut mesh = vec![0u8; 8];
        let mut put = |p: [f32; 3], c: [u8; 4]| { for x in [p[0], p[1], p[2], 0.0, 0.0] { mesh.extend_from_slice(&x.to_le_bytes()); } mesh.extend_from_slice(&c); };
        let quad = |put: &mut dyn FnMut([f32; 3], [u8; 4]), q: [[f32; 3]; 4], c: [u8; 4]| for i in [0, 1, 2, 0, 2, 3] { put(q[i], c) };
        let (ground, red) = ([150, 150, 150, 255], [200, 40, 40, 255]);
        quad(&mut put, [[-40.0, -40.0, 0.0], [40.0, -40.0, 0.0], [40.0, 40.0, 0.0], [-40.0, 40.0, 0.0]], ground);
        let (a, h) = (5.0f32, 10.0f32);
        quad(&mut put, [[-a, -a, h], [a, -a, h], [a, a, h], [-a, a, h]], red);
        for (p, q) in [([-a, -a], [a, -a]), ([a, -a], [a, a]), ([a, a], [-a, a]), ([-a, a], [-a, -a])] {
            quad(&mut put, [[p[0], p[1], 0.0], [q[0], q[1], 0.0], [q[0], q[1], h], [p[0], p[1], h]], red);
        }
        let n = ((mesh.len() - 8) / CORNER) as u32;
        mesh[0..4].copy_from_slice(&n.to_le_bytes());
        mesh[4..8].copy_from_slice(&60f32.to_le_bytes());
        set_scene(&mut g, &mesh, false).unwrap();
        // sun from the east, 45 deg high: the shadow falls west of the box; looking down from the south
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let v = View { w: 200, h: 200, az: 180.0, el: 89.0, dist: 120.0, target: [0.0; 3], sun: [s, 0.0, s], day: true, cells: [6.0, 12.0] };
        let px = render(&mut g, &v).unwrap();
        assert_eq!(px.len(), 200 * 200 * 4);
        let at = |x: usize, y: usize| { let i = (y * 200 + x) * 4; [px[i] as i32, px[i + 1] as i32, px[i + 2] as i32] };
        assert_eq!(at(0, 0), [188, 216, 238], "sky");
        assert!(at(100, 100)[0] > 150 && at(100, 100)[1] < 80, "box top {:?}", at(100, 100));
        let (shade, open) = (at(84, 100), at(116, 100));   // 10 m west and east of the centre
        assert!(shade[0] + 20 < open[0], "shadow {shade:?} against open ground {open:?}");
    }

    // a ground image of one known colour draws under the scene: half its colour at night, its own colour in the sun, darker
    // in the shadow of a box; skipped on a machine without a graphics adapter
    #[test]
    fn draws_the_ground_image_with_shadows() {
        let Ok(mut g) = init() else { eprintln!("no graphics adapter: skipped"); return };
        let ground = |w: u32, h: u32, z: f32| {
            let mut b = Vec::new();
            b.extend_from_slice(&w.to_le_bytes());
            b.extend_from_slice(&h.to_le_bytes());
            for [x, y] in [[-40.0f32, -40.0], [40.0, -40.0], [40.0, 40.0], [-40.0, 40.0]] { for c in [x, y, z] { b.extend_from_slice(&c.to_le_bytes()); } }
            for _ in 0..w * h { b.extend_from_slice(&[200, 100, 50, 255]); }
            b
        };
        set_ground(&mut g, &ground(8, 4, 0.0)).unwrap();
        let s = std::f64::consts::FRAC_1_SQRT_2;
        let mut v = View { w: 200, h: 200, az: 180.0, el: 89.0, dist: 120.0, target: [0.0; 3], sun: [s, 0.0, s], day: false, cells: [6.0, 12.0] };
        let px = render(&mut g, &v).unwrap();
        let at = |px: &[u8], x: usize, y: usize| { let i = (y * 200 + x) * 4; [px[i] as i32, px[i + 1] as i32, px[i + 2] as i32] };
        assert_eq!(at(&px, 0, 0), [74, 85, 102], "night sky outside the image");
        let c = at(&px, 100, 100);
        assert!((c[0] - 100).abs() <= 2 && (c[1] - 50).abs() <= 2 && (c[2] - 25).abs() <= 2, "the image at night {c:?}");
        // a box 10 m high with no ground of its own, under a sun from the east 45 deg high: its shadow falls on the image
        let mut mesh = vec![0u8; 8];
        let mut put = |p: [f32; 3]| { for x in [p[0], p[1], p[2], 0.0, 0.0] { mesh.extend_from_slice(&x.to_le_bytes()); } mesh.extend_from_slice(&[200, 40, 40, 255]); };
        let (a, h) = (5.0f32, 10.0f32);
        let mut quad = |q: [[f32; 3]; 4]| for i in [0, 1, 2, 0, 2, 3] { put(q[i]) };
        quad([[-a, -a, h], [a, -a, h], [a, a, h], [-a, a, h]]);
        for (p, q) in [([-a, -a], [a, -a]), ([a, -a], [a, a]), ([a, a], [-a, a]), ([-a, a], [-a, -a])] {
            quad([[p[0], p[1], 0.0], [q[0], q[1], 0.0], [q[0], q[1], h], [p[0], p[1], h]]);
        }
        let n = ((mesh.len() - 8) / CORNER) as u32;
        mesh[0..4].copy_from_slice(&n.to_le_bytes());
        mesh[4..8].copy_from_slice(&60f32.to_le_bytes());
        set_scene(&mut g, &mesh, false).unwrap();
        v.day = true;
        let px = render(&mut g, &v).unwrap();
        let (shade, open) = (at(&px, 84, 100), at(&px, 116, 100));
        assert!((open[0] - 200).abs() <= 2 && (open[1] - 100).abs() <= 2 && (open[2] - 50).abs() <= 2, "the image in the sun {open:?}");
        assert!(shade[0] + 40 < open[0] && shade[1] < open[1], "shadow {shade:?} on the image against {open:?}");
        // the quad moves and keeps its image; bad sizes and numbers are refused; empty clears it
        let mut keep = ground(0, 0, 0.0);
        for i in 0..4 { let o = 8 + 12 * i; let x = f32::from_le_bytes(keep[o..o + 4].try_into().unwrap()) + 1000.0; keep[o..o + 4].copy_from_slice(&x.to_le_bytes()); }
        set_ground(&mut g, &keep).unwrap();
        assert!(g.ground_tex.is_some() && g.ground_quad.is_some());
        let px = render(&mut g, &v).unwrap();
        assert_eq!(at(&px, 160, 100), [188, 216, 238], "the image moved 1 km east, the sky shows where it was");
        let mut wrong = ground(8, 4, 0.0);
        wrong.pop();
        assert!(set_ground(&mut g, &wrong).is_err(), "pixels short of w x h x 4");
        assert!(set_ground(&mut g, &ground(MAX_GROUND + 1, 1, 0.0)).is_err(), "wider than the largest image");
        assert!(set_ground(&mut g, &ground(4, 4, f32::NAN)).is_err(), "a corner not a number");
        assert!(set_ground(&mut g, &ground(0, 4, 0.0)).is_err(), "no width");
        assert!(set_ground(&mut g, &[0u8; 40]).is_err(), "short header");
        assert!(set_ground(&mut g, &ground(MAX_GROUND, 1, 0.0)).is_ok(), "the widest image");
        assert!(set_ground(&mut g, &[]).is_ok() && g.ground_tex.is_none() && g.ground_quad.is_none(), "empty clears it");
    }

    // whatever the page sends, the shell answers an error or a frame and never panics; skipped without a graphics adapter
    #[test]
    fn hostile_input_never_panics() {
        let Ok(mut g) = init() else { eprintln!("no graphics adapter: skipped"); return };
        let mut seed = 99u64;
        let mut next = || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); seed >> 33 };
        for _ in 0..300 {
            let n = (next() % 2000) as usize;
            let mut b: Vec<u8> = (0..n).map(|_| next() as u8).collect();
            if next() % 2 == 0 && b.len() >= 8 { let k = (((b.len() - 8) / CORNER) as u32).to_le_bytes(); b[..4].copy_from_slice(&k); }
            let _ = set_scene(&mut g, &b, false);
            if next() % 4 == 0 { let _ = set_ground(&mut g, &b); }
            let v = View { w: (next() % 64) as u32, h: (next() % 64) as u32, az: next() as f64, el: (next() % 200) as f64 - 100.0, dist: (next() % 1000) as f64 - 10.0,
                           target: [0.0, 0.0, 0.0], sun: [0.3, -0.2, (next() % 3) as f64 - 1.0], day: next() % 2 == 0, cells: [6.0, 12.0] };
            let _ = render(&mut g, &v);
        }
        for v in [f64::NAN, f64::INFINITY, -1.0, 0.0, 1e300] {
            assert!(render(&mut g, &View { w: 64, h: 64, az: 0.0, el: 30.0, dist: v, target: [0.0; 3], sun: [0.0, 0.0, 1.0], day: true, cells: [6.0, 12.0] }).is_err() || v > 0.0);
        }
        assert!(render(&mut g, &View { w: 0, h: 64, az: 0.0, el: 30.0, dist: 10.0, target: [0.0; 3], sun: [0.0, 0.0, 1.0], day: true, cells: [6.0, 12.0] }).is_err());
        assert!(render(&mut g, &View { w: 4097, h: 64, az: 0.0, el: 30.0, dist: 10.0, target: [0.0; 3], sun: [0.0, 0.0, 1.0], day: true, cells: [6.0, 12.0] }).is_err());
        // the largest frame, and a camera far out of the scene; more pixels than that is refused
        assert_eq!(render(&mut g, &View { w: 2048, h: 2048, az: 10.0, el: 30.0, dist: 50.0, target: [1e6, -1e6, 0.0], sun: [0.0, 0.0, 1.0], day: true, cells: [6.0, 12.0] }).unwrap().len(), 2048 * 2048 * 4);
        assert!(render(&mut g, &View { w: 4096, h: 4096, az: 10.0, el: 30.0, dist: 50.0, target: [0.0; 3], sun: [0.0, 0.0, 1.0], day: true, cells: [6.0, 12.0] }).is_err());
        // a moving item draws with the scene and goes again
        assert!(set_scene(&mut g, &[], true).is_ok() && g.moving.is_none());
        assert!(set_scene(&mut g, &[1, 0, 0, 0, 0, 0, 128, 63], false).is_err(), "one corner cannot be a triangle");
        assert!(set_scene(&mut g, &[], false).is_ok() && g.scene.is_none(), "empty clears the scene");
    }

    // frames asked for from many threads at once are drawn one at a time, each whole
    #[test]
    fn frames_in_parallel() {
        if GPU.lock().unwrap_or_else(|p| p.into_inner()).get_or_insert_with(init).is_err() { eprintln!("no graphics adapter: skipped"); return; }
        let hs: Vec<_> = (0..8).map(|i| std::thread::spawn(move || {
            for j in 0..10 {
                let mut lock = GPU.lock().unwrap_or_else(|p| p.into_inner());
                let g = lock.as_mut().unwrap().as_mut().unwrap();
                let (w, h) = (32 + i * 7 + j, 24 + j * 3);
                let px = render(g, &View { w, h, az: (i * 40) as f64, el: 30.0, dist: 30.0, target: [0.0; 3], sun: [0.0, 0.0, 1.0], day: true, cells: [6.0, 12.0] }).unwrap();
                assert_eq!(px.len(), (w * h * 4) as usize);
            }
        })).collect();
        for h in hs { h.join().unwrap(); }
    }
}
