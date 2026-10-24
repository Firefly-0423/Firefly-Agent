//! 基于 DXGI Desktop Duplication 的抓屏后端。
//!
//! 这是首选的抓屏路径：创建 D3D11 设备，复制主显示器的输出，
//! 并在一次交互期间保留少量 GPU 纹理，从而做到：
//!
//!   * 首帧送到覆盖层时**没有整屏 CPU 读回**（渲染器通过 D2D 直接绘制冻结的 GPU 纹理）；
//!   * 鼠标移动不会重新上传画面（只让 D2D 重绘失效）；
//!   * 提交时只做一次选区大小的 `CopySubresourceRegion` + `Map`，
//!     把 CPU BGRA 缓冲交给编码器/剪贴板。
//!
//! DXGI 初始化失败（没有 D3D11 设备、没有主输出，或启动时 `DuplicateOutput` 返回
//! `DXGI_ERROR_UNSUPPORTED` / `DXGI_ERROR_ACCESS_LOST`）时，
//! helper 在整个会话内改用 [`crate::win::capture_gdi::GdiCaptureBackend`]。
//!
//! 抓取循环跑在 UI 线程，由 [`DxgiCaptureBackend::refresh_latest`] 驱动：
//! 每次 `AcquireNextFrame` 使用 16–50 ms 的超时（绝不用 `INFINITE`），
//! 所以桌面静止时消息循环也保持响应。

use windows::Win32::Foundation::{HMODULE, RECT};
use windows::Win32::Graphics::Direct2D::Common as D2D;
use windows::Win32::Graphics::Direct2D::{
    D2D1_BITMAP_OPTIONS, D2D1_BITMAP_OPTIONS_CANNOT_DRAW, D2D1_BITMAP_OPTIONS_NONE,
    D2D1_BITMAP_OPTIONS_TARGET, D2D1_BITMAP_PROPERTIES1, D2D1_DEVICE_CONTEXT_OPTIONS_NONE,
    D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR, D2D1CreateDevice, ID2D1Bitmap1, ID2D1DeviceContext,
    ID2D1Image,
};
use windows::Win32::Graphics::Direct3D::{
    D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_9_1, D3D_FEATURE_LEVEL_9_2,
    D3D_FEATURE_LEVEL_9_3, D3D_FEATURE_LEVEL_10_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_11_1,
};
use windows::Win32::Graphics::Direct3D11::{
    D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_BOX, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE, D3D11_USAGE_DEFAULT, D3D11_USAGE_STAGING, D3D11CreateDevice,
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use windows::Win32::Graphics::Dxgi::{
    DXGI_ERROR_ACCESS_LOST, DXGI_ERROR_DEVICE_REMOVED, DXGI_ERROR_DEVICE_RESET,
    DXGI_ERROR_UNSUPPORTED, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO, IDXGIAdapter,
    IDXGIDevice, IDXGIOutput, IDXGIOutput1, IDXGIOutputDuplication, IDXGIResource, IDXGISurface,
};
use windows::Win32::UI::WindowsAndMessaging::{CURSOR_SHOWING, CURSORINFO, GetCursorInfo};
use windows::core::Interface;
use windows_numerics::Matrix3x2;

use crate::error::HelperError;
use crate::geometry::{DisplayRotation, RectI};
use crate::win::capture::{
    CaptureBackend, CaptureDiagnostics, CpuBgraFrame, FrozenFrame, GpuFrozenFrame, RefreshOutcome,
};
use crate::win::display::DisplayInfo;

/// 光标可见性探测结果，用来决定本次会话的抓屏策略，
/// 避免去调用开销较大的 `GetFramePointerShape`。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CursorVisibility {
    Hidden,
    /// 光标可见，且位于主显示器范围内。
    VisibleInside,
    /// 光标可见，但在主显示器之外（或在屏幕外）。
    VisibleOutside,
}

/// 规范显示坐标系下的选区矩形。单独做成一个类型，
/// 以免渲染器把物理像素坐标误传给 GPU 读回路径。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RectISelection {
    /// 左边界（显示本地坐标）
    pub x: u32,
    /// 上边界（显示本地坐标）
    pub y: u32,
    /// 选区宽度
    pub width: u32,
    /// 选区高度
    pub height: u32,
}

impl From<RectI> for RectISelection {
    fn from(rect: RectI) -> Self {
        // 渲染器发来的选区原点都在规范显示坐标系（与 display.bounds 一致，左上角为原点），
        // 这里对负值做保护性截断
        RectISelection {
            x: u32::try_from(rect.x).unwrap_or(0),
            y: u32::try_from(rect.y).unwrap_or(0),
            width: rect.width,
            height: rect.height,
        }
    }
}

/// 基于 DXGI 的主显示器抓屏。
///
/// 持有 D3D11 设备、duplication 接口以及两张纹理：
///
///   * `latest_texture`：每次取得新帧后通过 `CopyResource` 更新。
///   * `frozen_texture`：留在 GPU 上的冻结画面，渲染器把它绑定为 D2D 位图；
///     鼠标移动引起的重绘不会碰这张纹理。
///
/// 所有 COM 资源在后端析构时由引用计数自动释放，没有手动 `Release` 调用。
pub struct DxgiCaptureBackend {
    /// 累计计数，通过 `CaptureDiagnostics` 对外提供。
    duplication_rebuilds: u64,
    latest_copies: u64,
    selection_cpu_readbacks: u64,
    full_frame_cpu_readbacks: u64,
    /// `freeze()` 成功冻结 GPU 帧后记录，由 `OverlayRenderer::upload_frozen` 消费；
    /// `invalidate` 时清空。
    last_frame_info: Option<DXGI_OUTDUPL_FRAME_INFO>,
    rotation: DisplayRotation,
    /// 与 `display.bounds` 一致的规范宽高（旋转后）。
    canonical_height: u32,
    canonical_width: u32,
    /// `latest_texture` 的宽高（物理像素，旋转前）。
    physical_height: u32,
    physical_width: u32,
    /// 按显示朝向摆正后的冻结纹理（尺寸等于规范显示范围）。
    /// 非 Identity 旋转时为 `Some`，Identity 时为 `None`。
    frozen_oriented: Option<ID3D11Texture2D>,
    frozen_texture: ID3D11Texture2D,
    latest_texture: ID3D11Texture2D,
    duplication: IDXGIOutputDuplication,
    context: ID3D11DeviceContext,
    device: ID3D11Device,
}

impl std::fmt::Debug for DxgiCaptureBackend {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // COM 对象不参与输出，只列出尺寸、旋转与计数
        let mut out = f.debug_struct("DxgiCaptureBackend");
        out.field("physical_width", &self.physical_width);
        out.field("physical_height", &self.physical_height);
        out.field("canonical_width", &self.canonical_width);
        out.field("canonical_height", &self.canonical_height);
        out.field("rotation", &self.rotation);
        out.field("full_frame_cpu_readbacks", &self.full_frame_cpu_readbacks);
        out.field("selection_cpu_readbacks", &self.selection_cpu_readbacks);
        out.field("latest_copies", &self.latest_copies);
        out.field("duplication_rebuilds", &self.duplication_rebuilds);
        out.finish_non_exhaustive()
    }
}

/// 构造 `CaptureFailed` 错误。
fn capture_err(text: impl Into<String>) -> HelperError {
    HelperError::CaptureFailed(text.into())
}

/// 冻结纹理既要作渲染目标，也要作着色器资源。
fn frozen_bind_flags() -> u32 {
    (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32
}

impl DxgiCaptureBackend {
    /// 针对 `display` 初始化 DXGI 抓屏管线。
    /// 调用方负责在会话之间重新查询 `display`，使设备跟上当前的显示器拓扑。
    ///
    /// `force_init_failure` 是测试用的接缝，集成测试借它验证 GDI 后备路径，
    /// 无需重启进无桌面会话；生产调用方应始终传 `false`。
    pub fn new(display: &DisplayInfo, force_init_failure: bool) -> Result<Self, HelperError> {
        if force_init_failure {
            return Err(capture_err("DXGI init failure forced by test seam"));
        }

        let (device, context) = create_d3d11_device()?;
        let duplication = create_duplication(&device, display)?;
        let mode = unsafe { duplication.GetDesc() }.ModeDesc;

        let (physical_width, physical_height) = physical_dimensions(display);
        let (canonical_width, canonical_height) = (display.bounds.width, display.bounds.height);
        if (mode.Width, mode.Height) != (physical_width, physical_height) {
            return Err(capture_err(format!(
                "DXGI output dimensions {}x{} do not match primary display {}x{}",
                mode.Width, mode.Height, physical_width, physical_height
            )));
        }

        // latest 只接收拷贝；frozen 还要给渲染器当目标与着色器资源
        let size = (physical_width, physical_height);
        let latest_texture = create_default_texture(&device, size.0, size.1, 0)?;
        let frozen_texture = create_default_texture(&device, size.0, size.1, frozen_bind_flags())?;

        Ok(DxgiCaptureBackend {
            duplication_rebuilds: 0,
            latest_copies: 0,
            selection_cpu_readbacks: 0,
            full_frame_cpu_readbacks: 0,
            last_frame_info: None,
            rotation: display.rotation,
            canonical_height,
            canonical_width,
            physical_height,
            physical_width,
            frozen_oriented: None,
            frozen_texture,
            latest_texture,
            duplication,
            context,
            device,
        })
    }

    /// 在 `DXGI_ERROR_ACCESS_LOST` / `DXGI_ERROR_DEVICE_REMOVED` /
    /// `DXGI_ERROR_DEVICE_RESET` / `WM_DISPLAYCHANGE` / `WM_DPICHANGED` 之后，
    /// 重建 DXGI duplication 与纹理。返回新的后端，由调用方替换旧的。
    pub fn rebuild(&self, display: &DisplayInfo) -> Result<Self, HelperError> {
        let mut fresh = DxgiCaptureBackend::new(display, false)?;
        fresh.duplication_rebuilds = self.duplication_rebuilds.saturating_add(1);
        Ok(fresh)
    }

    /// 当前光标的可见状态（是否可见、是否在主显示器上）。
    /// 用于判断是否改走 GDI 冻结，以免画面里缺少系统箭头。
    pub fn cursor_visibility(&self) -> CursorVisibility {
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..CURSORINFO::default()
        };
        // SAFETY: GetCursorInfo 把结果写入传入的 CURSORINFO，cbSize 已按要求设置。
        if unsafe { GetCursorInfo(&mut info) }.is_err() {
            return CursorVisibility::Hidden;
        }
        if info.flags.0 & CURSOR_SHOWING.0 == 0 {
            return CursorVisibility::Hidden;
        }
        let at = info.ptScreenPos;
        let on_screen = at.x >= 0
            && at.y >= 0
            && (at.x as u64) < u64::from(self.canonical_width)
            && (at.y as u64) < u64::from(self.canonical_height);
        match on_screen {
            true => CursorVisibility::VisibleInside,
            false => CursorVisibility::VisibleOutside,
        }
    }

    /// 判断本次会话是否应放弃 DXGI。光标可见、而 DXGI 帧信息里
    /// `PointerPosition.Visible == false` 时，光标是被合成进桌面的，
    /// DXGI 不会绘制它，抓到的图里就缺少箭头；这种特殊情况下 helper 可以改走 GDI 冻结
    /// （`BitBlt` 加 `CAPTUREBLT` 会把光标层一并抓下来）。
    pub fn should_fallback_to_gdi(&self) -> bool {
        requires_gdi_for_cursor(self.cursor_visibility(), self.last_frame_info.as_ref())
    }

    /// 取出 `rect`（显示本地坐标，规范朝向）对应的 CPU BGRA 缓冲。
    /// 调用方应先把 `rect` 限制在冻结帧范围内；这里只校验宽高非零。
    pub fn read_selection_to_cpu(
        &mut self,
        // 显示本地坐标下的选区
        rect: RectISelection,
    ) -> Result<CpuBgraFrame, HelperError> {
        if rect.width == 0 || rect.height == 0 {
            return Err(capture_err(
                "read_selection_to_cpu called with zero-sized rect",
            ));
        }
        self.selection_cpu_readbacks = self.selection_cpu_readbacks.saturating_add(1);

        // 与选区同尺寸的暂存纹理，GPU 路径触及 CPU 内存的唯一地方：一次小区域拷贝
        let staging = create_staging_texture(&self.device, rect.width, rect.height)?;

        let source = match &self.frozen_oriented {
            Some(oriented) => oriented.clone(),
            None => self.frozen_texture.clone(),
        };

        // 单层（front..back 只有一层）的二维区域
        let region = D3D11_BOX {
            front: 0,
            back: 1,
            bottom: rect.y + rect.height,
            right: rect.x + rect.width,
            top: rect.y,
            left: rect.x,
        };
        // SAFETY: 把冻结纹理子资源 0 中 region 范围拷到暂存纹理子资源 0 的 (0,0,0) 处；
        // 暂存纹理按 rect 尺寸创建，所以区域必然放得下。
        unsafe {
            self.context
                .CopySubresourceRegion(&staging, 0, 0, 0, 0, &source, 0, Some(&region));
        }

        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        // SAFETY: 对暂存纹理的可读子资源执行 Map 按文档必定成功，成功后 pData 非空。
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        }
        .map_err(|error| capture_err(format!("Map(selection staging) failed: {error}")))?;

        let row_bytes = (rect.width as usize)
            .checked_mul(4)
            .ok_or_else(|| capture_err("selection row overflow"))?;
        let total_bytes = row_bytes
            .checked_mul(rect.height as usize)
            .ok_or_else(|| capture_err("selection total overflow"))?;
        if total_bytes > isize::MAX as usize {
            return Err(capture_err("selection pixel buffer exceeds isize::MAX"));
        }
        let mut pixels = vec![0u8; total_bytes];
        let src_pitch = mapped.RowPitch as usize;
        // SAFETY: pData 非空，指向 src_pitch * height 字节的缓冲；
        // 每行复制 row_bytes 字节，并以 RowPitch 为上限。
        unsafe {
            let base = mapped.pData as *const u8;
            for row in 0..rect.height as usize {
                std::ptr::copy_nonoverlapping(
                    base.add(row * src_pitch),
                    pixels.as_mut_ptr().add(row * row_bytes),
                    row_bytes.min(src_pitch),
                );
            }
        }
        unsafe { self.context.Unmap(&staging, 0) };

        Ok(CpuBgraFrame {
            pixels,
            pitch: rect.width * 4,
            height: rect.height,
            width: rect.width,
        })
    }

    /// 把刚取得的帧拷进 `latest_texture`，返回这一帧带来的结果。
    fn ingest_acquired(
        &mut self,
        info: DXGI_OUTDUPL_FRAME_INFO,
        resource: Option<IDXGIResource>,
    ) -> Result<RefreshOutcome, HelperError> {
        self.last_frame_info = Some(info);
        // 没有新的呈现，画面未变
        if info.LastPresentTime == 0 {
            return Ok(RefreshOutcome::Unchanged);
        }

        let resource = resource
            .ok_or_else(|| capture_err("AcquireNextFrame succeeded without a desktop resource"))?;
        let acquired: ID3D11Texture2D = resource.cast().map_err(|error| {
            capture_err(format!(
                "IDXGIResource.cast to ID3D11Texture2D failed: {error}"
            ))
        })?;

        let mut theirs = D3D11_TEXTURE2D_DESC::default();
        let mut ours = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            acquired.GetDesc(&mut theirs);
            self.latest_texture.GetDesc(&mut ours);
        }
        let compatible = theirs.Width == ours.Width
            && theirs.Height == ours.Height
            && theirs.Format == ours.Format
            && theirs.SampleDesc.Count == ours.SampleDesc.Count;
        if !compatible {
            return Err(capture_err(format!(
                "DXGI acquired texture {}x{} {:?} is incompatible with latest texture {}x{} {:?}",
                theirs.Width, theirs.Height, theirs.Format, ours.Width, ours.Height, ours.Format
            )));
        }

        // 同一设备上几何一致的 DEFAULT GPU 纹理，可以直接 CopyResource
        unsafe { self.context.CopyResource(&self.latest_texture, &acquired) };
        self.latest_copies = self.latest_copies.saturating_add(1);
        Ok(RefreshOutcome::Updated)
    }
}

// --- DXGI 辅助函数 ---------------------------------------------------------

fn create_d3d11_device() -> Result<(ID3D11Device, ID3D11DeviceContext), HelperError> {
    // 由高到低依次尝试的特性级别
    let levels: [D3D_FEATURE_LEVEL; 7] = [
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0, // D3D11
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0, // D3D10
        D3D_FEATURE_LEVEL_9_3,
        D3D_FEATURE_LEVEL_9_2,
        D3D_FEATURE_LEVEL_9_1, // 9.x
    ];
    let mut device = None;
    let mut context = None;
    // SAFETY: 输出指针可写，特性级别切片在整个调用期间有效；
    // adapter 传 None 表示使用默认 GPU。
    let created = unsafe {
        D3D11CreateDevice(
            None, // 默认适配器
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE(std::ptr::null_mut()),    // 不使用软件光栅化模块
            D3D11_CREATE_DEVICE_BGRA_SUPPORT, // D2D 互操作需要 BGRA
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None, // 不关心实际选中的特性级别
            Some(&mut context),
        )
    };
    created.map_err(|error| {
        capture_err(format!(
            "D3D11CreateDevice failed: {error} (last error: {})",
            windows::core::Error::from_thread().message()
        ))
    })?;
    Ok((
        device.expect("D3D11CreateDevice succeeded with no device"),
        context.expect("D3D11CreateDevice succeeded with no context"),
    ))
}

/// 在适配器的输出里找出与主显示器范围一致、且已接入桌面的那个。
fn find_primary_output(
    adapter: &IDXGIAdapter,
    display: &DisplayInfo,
) -> Result<IDXGIOutput, HelperError> {
    for index in 0..16 {
        // 枚举到末尾（或出错）就停止
        let Ok(output) = (unsafe { adapter.EnumOutputs(index) }) else {
            break;
        };
        let desc = unsafe { output.GetDesc() }.map_err(|error| {
            capture_err(format!("IDXGIOutput::GetDesc({index}) failed: {error}"))
        })?;
        if desc.AttachedToDesktop.as_bool()
            && output_bounds_match_display(desc.DesktopCoordinates, display)
        {
            return Ok(output);
        }
    }
    let b = display.bounds;
    Err(capture_err(format!(
        "D3D11 adapter has no output matching primary display at ({}, {}) {}x{}",
        b.x, b.y, b.width, b.height
    )))
}

/// 找到主显示器对应的输出并建立 duplication。
fn create_duplication(
    // 抓屏所用的 D3D11 设备
    device: &ID3D11Device,
    display: &DisplayInfo,
) -> Result<IDXGIOutputDuplication, HelperError> {
    let dxgi_device: IDXGIDevice = device.cast().map_err(|error| {
        capture_err(format!("ID3D11Device.cast to IDXGIDevice failed: {error}"))
    })?;
    let adapter: IDXGIAdapter = unsafe { dxgi_device.GetParent() }
        .map_err(|error| capture_err(format!("IDXGIDevice::GetParent(adapter) failed: {error}")))?;
    let output = find_primary_output(&adapter, display)?;
    let output1: IDXGIOutput1 = output.cast().map_err(|error| {
        capture_err(format!("IDXGIOutput.cast to IDXGIOutput1 failed: {error}"))
    })?;
    unsafe { output1.DuplicateOutput(device) }.map_err(|error| {
        // 非交互会话（服务、受 UAC 限制的进程等）下最常见的是 E_UNSUPPORTED；
        // 统一转成结构化的 CaptureFailed，供应用层改走 GDI。
        let code = error.code();
        if code == DXGI_ERROR_UNSUPPORTED {
            capture_err("DXGI DuplicateOutput returned E_UNSUPPORTED (session is not interactive)")
        } else if code == DXGI_ERROR_ACCESS_LOST {
            capture_err("DXGI DuplicateOutput returned ACCESS_LOST (display device changed)")
        } else {
            capture_err(format!("DXGI DuplicateOutput failed: {error}"))
        }
    })
}

fn output_bounds_match_display(output: RECT, display: &DisplayInfo) -> bool {
    let b = display.bounds;
    let edges = (
        i64::from(output.left),
        i64::from(output.top),
        i64::from(output.right),
        i64::from(output.bottom),
    );
    let wanted = (
        i64::from(b.x),
        i64::from(b.y),
        i64::from(b.x) + i64::from(b.width),
        i64::from(b.y) + i64::from(b.height),
    );
    edges == wanted
}

/// CPU 可读的暂存纹理，用来读回选区。
fn create_staging_texture(
    device: &ID3D11Device,
    // 与选区同样大小
    width: u32,
    height: u32,
) -> Result<ID3D11Texture2D, HelperError> {
    let cpu_read = D3D11_CPU_ACCESS_READ.0 as u32;
    make_texture(device, width, height, D3D11_USAGE_STAGING, cpu_read, 0)
}

/// GPU 专用纹理，由 `bind_flags` 决定用途。
fn create_default_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    // D3D11_BIND_FLAG 的组合
    bind_flags: u32,
) -> Result<ID3D11Texture2D, HelperError> {
    make_texture(device, width, height, D3D11_USAGE_DEFAULT, 0, bind_flags)
}

fn make_texture(
    device: &ID3D11Device,
    width: u32,
    height: u32,
    usage: D3D11_USAGE,
    cpu_access: u32,
    bind_flags: u32,
) -> Result<ID3D11Texture2D, HelperError> {
    // 固定单层、单个、不做多重采样的 BGRA 纹理
    let desc = D3D11_TEXTURE2D_DESC {
        MiscFlags: 0,
        CPUAccessFlags: cpu_access,
        BindFlags: bind_flags,
        Usage: usage,
        SampleDesc: DXGI_SAMPLE_DESC {
            Quality: 0,
            Count: 1,
        },
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        ArraySize: 1,
        MipLevels: 1,
        Height: height,
        Width: width,
    };
    let mut made: Option<ID3D11Texture2D> = None;
    // SAFETY: desc 描述一张合法的 2D BGRA 纹理；调用把新纹理写入 made。
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut made)) }.map_err(|error| {
        capture_err(format!(
            "CreateTexture2D failed: {error} (last error: {})",
            windows::core::Error::from_thread().message()
        ))
    })?;
    made.ok_or_else(|| capture_err("CreateTexture2D returned no texture"))
}

fn pointer_position_was_visible(frame: &DXGI_OUTDUPL_FRAME_INFO) -> bool {
    frame.PointerPosition.Visible.as_bool()
}

/// 光标可见、而 DXGI 的帧信息没有绘出指针时，需要改走 GDI。
fn requires_gdi_for_cursor(
    cursor: CursorVisibility,
    // 最近一帧的帧信息，还没有取过帧时为 None
    frame: Option<&DXGI_OUTDUPL_FRAME_INFO>,
) -> bool {
    if cursor == CursorVisibility::Hidden {
        return false;
    }
    match frame {
        Some(info) => !pointer_position_was_visible(info),
        None => false,
    }
}

// --- 几何辅助 --------------------------------------------------------------

/// 旋转 90/270 度时宽高互换，其余朝向保持不变。
fn swap_for_quarter_turns(a: u32, b: u32, rotation: DisplayRotation) -> (u32, u32) {
    match rotation {
        DisplayRotation::Rotate90 | DisplayRotation::Rotate270 => (b, a),
        DisplayRotation::Identity | DisplayRotation::Rotate180 => (a, b),
    }
}

fn physical_dimensions(display: &DisplayInfo) -> (u32, u32) {
    swap_for_quarter_turns(
        display.bounds.width,
        display.bounds.height,
        display.rotation,
    )
}

fn physical_to_canonical(
    physical_w: u32,
    physical_h: u32,
    rotation: DisplayRotation,
) -> (u32, u32) {
    swap_for_quarter_turns(physical_w, physical_h, rotation)
}

/// 把物理像素放入规范显示范围的 2D 仿射变换，按 [M11, M12, M21, M22, M31, M32] 排列。
fn rotation_transform(
    // 物理（旋转前）尺寸
    physical_width: u32,
    physical_height: u32,
    // 显示器当前的旋转角度
    rotation: DisplayRotation,
) -> [f32; 6] {
    let (w, h) = (physical_width as f32, physical_height as f32);
    match rotation {
        DisplayRotation::Identity => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        DisplayRotation::Rotate90 => [0.0, 1.0, -1.0, 0.0, h, 0.0],
        DisplayRotation::Rotate180 => [-1.0, 0.0, 0.0, -1.0, w, h],
        DisplayRotation::Rotate270 => [0.0, -1.0, 1.0, 0.0, 0.0, w],
    }
}

/// 在 D2D 设备上，用 `texture` 的 DXGI 表面建立位图。`role` 只用于错误文字。
fn wrap_texture_as_bitmap(
    context: &ID2D1DeviceContext,
    texture: &ID3D11Texture2D,
    options: D2D1_BITMAP_OPTIONS,
    role: &str,
) -> Result<ID2D1Bitmap1, HelperError> {
    let surface: IDXGISurface = texture.cast().map_err(|error| {
        capture_err(format!(
            "{role} texture cast to IDXGISurface for rotation failed: {error}"
        ))
    })?;
    let properties = D2D1_BITMAP_PROPERTIES1 {
        pixelFormat: D2D::D2D1_PIXEL_FORMAT {
            format: DXGI_FORMAT_B8G8R8A8_UNORM,
            alphaMode: D2D::D2D1_ALPHA_MODE_IGNORE,
        },
        dpiX: 96.0,
        dpiY: 96.0,
        bitmapOptions: options,
        colorContext: core::mem::ManuallyDrop::new(None),
    };
    unsafe { context.CreateBitmapFromDxgiSurface(&surface, Some(&properties)) }.map_err(|error| {
        capture_err(format!(
            "CreateBitmapFromDxgiSurface({role}) for rotation failed: {error}"
        ))
    })
}

/// 用 D2D 把 `source`（物理朝向）按 `rotation` 绘制到 `target`（规范朝向）。
fn render_rotated_texture(
    device: &ID3D11Device,
    source: &ID3D11Texture2D,
    target: &ID3D11Texture2D,
    // 源纹理的物理尺寸
    physical_width: u32,
    physical_height: u32,
    // 要抵消的显示旋转
    rotation: DisplayRotation,
) -> Result<(), HelperError> {
    let dxgi_device: IDXGIDevice = device.cast().map_err(|error| {
        capture_err(format!(
            "D3D11 device cast to IDXGIDevice for rotation failed: {error}"
        ))
    })?;
    let d2d_device = unsafe { D2D1CreateDevice(&dxgi_device, None) }.map_err(|error| {
        capture_err(format!(
            "D2D1CreateDevice for rotated freeze failed: {error}"
        ))
    })?;
    let context = unsafe { d2d_device.CreateDeviceContext(D2D1_DEVICE_CONTEXT_OPTIONS_NONE) }
        .map_err(|error| {
            capture_err(format!(
                "CreateDeviceContext for rotated freeze failed: {error}"
            ))
        })?;

    // 源纹理只读，目标纹理作为渲染目标且不可直接绘制
    let source_bitmap =
        wrap_texture_as_bitmap(&context, source, D2D1_BITMAP_OPTIONS_NONE, "source")?;
    let target_bitmap = wrap_texture_as_bitmap(
        &context,
        target,
        D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
        "target",
    )?;

    let [m11, m12, m21, m22, m31, m32] =
        rotation_transform(physical_width, physical_height, rotation);
    let transform = Matrix3x2 {
        M31: m31,
        M32: m32,
        M21: m21,
        M22: m22,
        M11: m11,
        M12: m12,
    };
    let whole_source = D2D::D2D_RECT_F {
        bottom: physical_height as f32,
        right: physical_width as f32,
        top: 0.0,
        left: 0.0,
    };
    // 最近邻采样，保证像素不被插值
    unsafe {
        context.SetTarget(&target_bitmap);
        context.BeginDraw();
        context.SetTransform(&transform);
        context.DrawBitmap(
            &source_bitmap,
            Some(&whole_source),
            1.0, // 不透明度
            D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR,
            None,
            None,
        );
    }
    let finished = unsafe { context.EndDraw(None, None) }
        .map_err(|error| capture_err(format!("EndDraw for rotated freeze failed: {error}")));
    // 无论绘制是否成功都要解除渲染目标
    unsafe { context.SetTarget(None::<&ID2D1Image>) };
    finished
}

impl CaptureBackend for DxgiCaptureBackend {
    fn name(&self) -> &'static str {
        "dxgi"
    }

    fn diagnostics(&self) -> CaptureDiagnostics {
        CaptureDiagnostics {
            duplication_rebuilds: self.duplication_rebuilds,
            latest_copies: self.latest_copies,
            selection_cpu_readbacks: self.selection_cpu_readbacks,
            full_frame_cpu_readbacks: self.full_frame_cpu_readbacks,
            backend: "dxgi",
        }
    }

    fn record_selection_readback(&mut self) {
        self.selection_cpu_readbacks = self.selection_cpu_readbacks.saturating_add(1);
    }

    fn should_fallback_to_gdi(&self) -> bool {
        DxgiCaptureBackend::should_fallback_to_gdi(self)
    }

    fn invalidate(&mut self) {
        self.last_frame_info = None;
        self.frozen_oriented = None;
    }

    // 整体换成新建的后端（计数在 rebuild 中累加）
    fn recover(&mut self, display: &DisplayInfo) -> Result<(), HelperError> {
        *self = DxgiCaptureBackend::rebuild(self, display)?;
        Ok(())
    }

    // 拉取一帧；超时视为没有变化，设备丢失则报告 Lost
    fn refresh_latest(&mut self, timeout_ms: u32) -> Result<RefreshOutcome, HelperError> {
        // 把提示值限制在 16..=50 ms，等待一帧时最多睡 50 ms
        let wait_ms = timeout_ms.clamp(16, 50);
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        let acquired = unsafe {
            self.duplication
                .AcquireNextFrame(wait_ms, &mut info, &mut resource)
        };

        if let Err(error) = acquired {
            let code = error.code();
            return if code == DXGI_ERROR_WAIT_TIMEOUT {
                Ok(RefreshOutcome::Unchanged)
            } else if [
                DXGI_ERROR_ACCESS_LOST,
                DXGI_ERROR_DEVICE_REMOVED,
                DXGI_ERROR_DEVICE_RESET,
            ]
            .contains(&code)
            {
                Ok(RefreshOutcome::Lost)
            } else {
                Err(capture_err(format!("AcquireNextFrame failed: {error}")))
            };
        }

        let outcome = self.ingest_acquired(info, resource);
        // 无论处理结果如何都要归还这一帧；归还失败的错误优先返回
        if let Err(error) = unsafe { self.duplication.ReleaseFrame() } {
            return Err(capture_err(format!("ReleaseFrame failed: {error}")));
        }
        outcome
    }

    // 冻结当前画面；全程留在 GPU，不做 CPU 读回
    fn freeze(&mut self, display: &DisplayInfo) -> Result<FrozenFrame, HelperError> {
        // 至少刷新一次，保证 latest_texture 里是最新画面。
        // 渲染器会在覆盖层存续期间一直持有 GPU 纹理，
        // 所以这里绝不能把整帧读回 CPU。
        for _ in 0..5 {
            let outcome = self.refresh_latest(50)?;
            match outcome {
                RefreshOutcome::Lost => {
                    // 由调用方在下次冻结前重建后端；这里返回结构化错误，
                    // 供应用层改走 GDI
                    return Err(capture_err("DXGI duplication lost; rebuild required"));
                }
                // 拿到新帧，或虽无新帧但此前已有可用画面，都可以停止等待
                RefreshOutcome::Updated => break,
                RefreshOutcome::Unchanged if self.latest_copies > 0 => break,
                RefreshOutcome::Unchanged => continue,
            }
        }
        if self.latest_copies == 0 {
            return Err(capture_err(
                "DXGI did not produce an initial desktop frame within 250 ms",
            ));
        }

        // GPU 内拷贝 frozen_texture <- latest_texture，不涉及 CPU 读回。
        // SAFETY: 两张纹理来自同一设备且尺寸一致，此时 CopyResource 按文档是安全的。
        unsafe {
            self.context
                .CopyResource(&self.frozen_texture, &self.latest_texture);
        }

        // 非 Identity 旋转时，分配（或重建）摆正后的冻结纹理；Identity 直接复用 frozen_texture
        let (canonical_w, canonical_h) =
            physical_to_canonical(self.physical_width, self.physical_height, display.rotation);
        if display.rotation == DisplayRotation::Identity {
            self.frozen_oriented = None;
        } else {
            let oriented = create_default_texture(
                &self.device,
                canonical_w,
                canonical_h,
                frozen_bind_flags(),
            )?;
            let (src_w, src_h) = (self.physical_width, self.physical_height);
            render_rotated_texture(
                &self.device,
                &self.frozen_texture,
                &oriented,
                src_w,
                src_h,
                display.rotation,
            )?;
            self.frozen_oriented = Some(oriented);
        }

        self.rotation = display.rotation;
        self.canonical_height = canonical_h;
        self.canonical_width = canonical_w;

        Ok(FrozenFrame::Gpu(GpuFrozenFrame {
            context: self.context.clone(),
            device: self.device.clone(),
            frozen_oriented: self.frozen_oriented.clone(),
            frozen: self.frozen_texture.clone(),
            rotation: display.rotation,
            height: canonical_h,
            width: canonical_w,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn full_hd_display(rotation: DisplayRotation) -> DisplayInfo {
        let bounds = RectI {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        DisplayInfo {
            rotation,
            bounds,
            is_primary: true,
            dpi: 96.0,
        }
    }

    #[test]
    fn physical_dimensions_swaps_for_rotated_displays() {
        assert_eq!(
            physical_dimensions(&full_hd_display(DisplayRotation::Identity)),
            (1920, 1080)
        );
        for turned in [DisplayRotation::Rotate90, DisplayRotation::Rotate270] {
            assert_eq!(physical_dimensions(&full_hd_display(turned)), (1080, 1920));
        }
    }

    #[test]
    fn cursor_visibility_does_not_panic_when_get_cursor_info_fails() {
        // 单元测试里没有真实 D3D 设备，无法构造 DxgiCaptureBackend，
        // 所以只演练仅依赖 GetCursorInfo 的那部分：调用失败时可见性必须是 Hidden。
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..CURSORINFO::default()
        };
        let _queried = unsafe { GetCursorInfo(&mut info) };
        // 除了“没有 panic”之外不做断言；构造后端需要真实设备，留给集成测试
    }

    #[test]
    fn pointer_position_visibility_uses_the_documented_visible_field() {
        let mut frame = DXGI_OUTDUPL_FRAME_INFO::default();
        let pointer = &mut frame.PointerPosition;
        (pointer.Position.x, pointer.Position.y) = (0, 0);
        assert!(!pointer_position_was_visible(&frame));

        // 坐标取任何值（包括符号位置位）都不能被当作“可见”
        frame.PointerPosition.Position.x = 0x8000_0000u32 as i32;
        let seen = pointer_position_was_visible(&frame);
        assert!(!seen, "pointer coordinates do not encode visibility");

        frame.PointerPosition.Visible = true.into();
        assert!(pointer_position_was_visible(&frame));
    }

    #[test]
    fn rotation_transforms_map_physical_pixels_into_canonical_bounds() {
        let cases = [
            (DisplayRotation::Identity, [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]),
            (DisplayRotation::Rotate90, [0.0, 1.0, -1.0, 0.0, 3.0, 0.0]),
            (DisplayRotation::Rotate180, [-1.0, 0.0, 0.0, -1.0, 2.0, 3.0]),
            (DisplayRotation::Rotate270, [0.0, -1.0, 1.0, 0.0, 0.0, 2.0]),
        ];
        for (rotation, expected) in cases {
            assert_eq!(rotation_transform(2, 3, rotation), expected);
        }
    }

    #[test]
    fn gpu_rotation_renders_source_pixels_into_the_oriented_texture() {
        let (device, context) = create_d3d11_device().expect("test D3D11 device");
        let sample_only = D3D11_BIND_SHADER_RESOURCE.0 as u32;
        let source = create_default_texture(&device, 2, 3, sample_only).expect("source texture");
        let target = create_default_texture(&device, 3, 2, frozen_bind_flags())
            .expect("oriented target texture");
        // 源图 2 列 3 行，蓝色分量依次为 1..=6
        let pixels: Vec<u8> = (1u8..=6).flat_map(|blue| [blue, 0, 0, 255]).collect();
        // 上传整张源图：行距 2 个像素
        let row_pitch = 2 * 4;
        unsafe {
            context.UpdateSubresource(
                &source,
                0,
                None,
                pixels.as_ptr().cast(),
                row_pitch,
                pixels.len() as u32,
            );
        }

        let drawn =
            render_rotated_texture(&device, &source, &target, 2, 3, DisplayRotation::Rotate90);
        drawn.expect("GPU rotation");

        // 读回旋转后的纹理逐像素检查
        let staging = create_staging_texture(&device, 3, 2).expect("staging texture");
        unsafe { context.CopyResource(&staging, &target) };
        let mut mapped = Default::default();
        let mapping = unsafe { context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) };
        mapping.expect("map oriented texture");
        let mut blues = Vec::new();
        for row in 0..2usize {
            let bytes = unsafe {
                std::slice::from_raw_parts(
                    (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                    3 * 4,
                )
            };
            blues.extend(bytes.chunks(4).map(|px| px[0]));
        }
        unsafe { context.Unmap(&staging, 0) };

        assert_eq!(blues, [5, 3, 1, 6, 4, 2]);
    }

    #[test]
    fn cursor_policy_only_falls_back_when_dxgi_omits_a_visible_cursor() {
        let mut frame = DXGI_OUTDUPL_FRAME_INFO::default();
        // 指针未被 DXGI 绘出：只有光标可见时才需要后备
        assert!(!requires_gdi_for_cursor(
            CursorVisibility::Hidden,
            Some(&frame)
        ));
        for visible in [
            CursorVisibility::VisibleInside,
            CursorVisibility::VisibleOutside,
        ] {
            assert!(requires_gdi_for_cursor(visible, Some(&frame)));
        }

        // 指针已被绘出，或者还没有帧信息：不需要后备
        frame.PointerPosition.Visible = true.into();
        let inside = CursorVisibility::VisibleInside;
        assert!(!requires_gdi_for_cursor(inside, Some(&frame)));
        assert!(!requires_gdi_for_cursor(inside, None));
    }

    #[test]
    fn duplication_output_must_match_the_primary_monitor_bounds() {
        let display = full_hd_display(DisplayRotation::Identity);
        let rect = |left, top, right, bottom| RECT {
            left,
            top,
            right,
            bottom,
        };
        assert!(output_bounds_match_display(
            rect(0, 0, 1920, 1080),
            &display
        ));
        assert!(!output_bounds_match_display(
            rect(1920, 0, 3840, 1080),
            &display
        ));
    }
}
