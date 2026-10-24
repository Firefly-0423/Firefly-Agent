//! 基于 GDI 的 [`CaptureBackend`] 实现。
//!
//! 抓取主显示器的流程：
//!
//!   1. 用 [`CreateDIBSection`] 建一个 32 位自上而下的 DIB，
//!      尺寸等于显示器物理范围（规范朝向）。
//!   2. 以 `SRCCOPY | CAPTUREBLT` 把桌面 DC 的内容 `BitBlt` 到 DIB 的内存 DC。
//!   3. 把 DIB 的像素按 BGRA 缓冲区读出。
//!   4. 旋转缓冲区，使其宽高与规范朝向下的 `display.bounds` 相符，
//!      不受系统报告的旋转影响。
//!
//! GDI 按需拉取，没有持续的帧缓冲可刷新，
//! 所以 [`refresh_latest`](CaptureBackend::refresh_latest) 恒返回 [`RefreshOutcome::Unchanged`]。
//!
//! 所有 GDI 句柄（`screen_dc`、`memory_dc`、`dib_section`）都由 RAII 守卫持有。
//! 守卫按依赖顺序获取（屏幕 → 内存 → DIB），按相反顺序释放，
//! 因此任何中间步骤 panic 也会释放之前已取得的句柄。

use windows::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleDC, CreateDIBSection,
    DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, HBITMAP, HDC, HGDIOBJ, RGBQUAD, ReleaseDC,
    SRCCOPY, SelectObject,
};

use crate::error::HelperError;
use crate::geometry::DisplayRotation;
use crate::win::capture::{
    CaptureBackend, CaptureDiagnostics, CpuBgraFrame, FrozenFrame, RefreshOutcome,
};
use crate::win::display::DisplayInfo;

/// 当前线程最近一次 Win32 错误的文字说明，拼进错误信息里。
fn thread_error_text() -> String {
    windows::core::Error::from_thread().message()
}

/// 带上最近 Win32 错误说明的 `CaptureFailed`。
fn failed_with_last_error(what: &str) -> HelperError {
    HelperError::CaptureFailed(format!("{what} (last error: {})", thread_error_text()))
}

/// 基于 GDI 的主显示器抓屏。
///
/// 不保留任何长期状态：每次冻结都新建 DC 和 DIB。
/// 构造函数只确认进程能拿到桌面 DC，GDI 不可用时尽早给出结构化错误。
///
/// 构造可能失败（非交互会话、无桌面的服务等都会让 GDI 不可用），
/// 调用方必须显式处理；故意不提供 `Default`，因为在生产环境里 panic 并不合适。
#[derive(Debug)]
pub struct GdiCaptureBackend {
    // 以下三个都是只增不减的计数
    latest_copies: u64,
    selection_cpu_readbacks: u64,
    full_frame_cpu_readbacks: u64,
}

impl GdiCaptureBackend {
    /// 创建后端。因为没有长期状态，这里只是临时取一次桌面 DC 再放掉，
    /// 好在无交互桌面时直接得到确定的 `CaptureFailed`，而不是等到第一次 freeze。
    pub fn new() -> Result<Self, HelperError> {
        ScreenDcGuard::acquire().map(drop)?;
        Ok(GdiCaptureBackend {
            latest_copies: 0,
            selection_cpu_readbacks: 0,
            full_frame_cpu_readbacks: 0,
        })
    }
}

impl CaptureBackend for GdiCaptureBackend {
    fn name(&self) -> &'static str {
        "gdi"
    }

    fn refresh_latest(&mut self, _timeout_ms: u32) -> Result<RefreshOutcome, HelperError> {
        // 没有生产者/消费者管线可推进，刷新永远视为无变化
        Ok(RefreshOutcome::Unchanged)
    }

    fn freeze(&mut self, display: &DisplayInfo) -> Result<FrozenFrame, HelperError> {
        let raw = capture_primary_bgra(display)?;
        let (width, height, pitch, pixels) = rotate_to_canonical(raw, display.rotation)?;
        // 每次冻结都算一次整帧 CPU 读回，同时也算一次“最新帧拷贝”
        for counter in [&mut self.full_frame_cpu_readbacks, &mut self.latest_copies] {
            *counter = counter.saturating_add(1);
        }
        let frame = CpuBgraFrame {
            pixels,
            pitch,
            height,
            width,
        };
        Ok(FrozenFrame::Cpu(frame))
    }

    fn invalidate(&mut self) {
        // 没有持久状态
    }

    fn diagnostics(&self) -> CaptureDiagnostics {
        // GDI 没有 duplication，重建次数恒为 0
        CaptureDiagnostics {
            duplication_rebuilds: 0,
            latest_copies: self.latest_copies,
            selection_cpu_readbacks: self.selection_cpu_readbacks,
            full_frame_cpu_readbacks: self.full_frame_cpu_readbacks,
            backend: "gdi",
        }
    }

    fn record_selection_readback(&mut self) {
        self.selection_cpu_readbacks = self.selection_cpu_readbacks.saturating_add(1);
    }
}

// ---- GDI 句柄守卫 ----------------------------------------------------------
//
// HDC 没有 `windows_core::Free` 实现，所以这里写几个各管一个句柄的小守卫，
// 在 `Drop` 里释放。守卫不是 `Send`：GDI 句柄绑定到获取它的线程，
// 而 helper 里只有 UI 线程会用到它们。

/// 持有 `GetDC(None)` 取得的 HDC，用 `ReleaseDC` 释放。
struct ScreenDcGuard(HDC);

impl ScreenDcGuard {
    fn acquire() -> Result<Self, HelperError> {
        // SAFETY: `GetDC(None)` 返回整个屏幕的 DC，除进程拥有窗口站/桌面外没有别的前提，
        // 而这一点已由上游的显示器查询成功所保证；句柄在 Drop 里用 ReleaseDC 归还。
        let hdc = unsafe { GetDC(None) };
        match hdc.is_invalid() {
            true => Err(failed_with_last_error("GetDC returned an invalid handle")),
            false => Ok(ScreenDcGuard(hdc)),
        }
    }
}

impl Drop for ScreenDcGuard {
    fn drop(&mut self) {
        // SAFETY: 句柄来自 acquire 中的 GetDC(None)，只能用对应的 ReleaseDC 归还。
        // 返回值忽略：释放失败说明句柄已经失效，没有可做的补救。
        let _ = unsafe { ReleaseDC(None, self.0) };
    }
}

/// 持有 `CreateCompatibleDC` 创建的 HDC，用 `DeleteDC` 销毁。
struct MemoryDcGuard(HDC);

impl MemoryDcGuard {
    fn create(parent: HDC) -> Result<Self, HelperError> {
        // SAFETY: 以桌面 DC 为参照创建兼容 DC，使其像素格式与屏幕一致；
        // 句柄在 Drop 里用 DeleteDC 销毁。
        let hdc = unsafe { CreateCompatibleDC(Some(parent)) };
        match hdc.is_invalid() {
            true => Err(failed_with_last_error(
                "CreateCompatibleDC returned an invalid handle",
            )),
            false => Ok(MemoryDcGuard(hdc)),
        }
    }

    /// 取出底层 HDC（仍由本守卫持有）。
    fn handle(&self) -> HDC {
        self.0
    }
}

impl Drop for MemoryDcGuard {
    fn drop(&mut self) {
        // SAFETY: 由 CreateCompatibleDC 得到的 HDC，按约定用 DeleteDC 销毁。
        let _ = unsafe { DeleteDC(self.0) };
    }
}

/// 持有 `CreateDIBSection` 得到的 HBITMAP，用 `DeleteObject` 销毁。
/// 在它之后声明的 `SelectionGuard` 会先于它析构并还原内存 DC，
/// 以遵守 Win32“已选入 DC 的位图不得删除”的规则。
struct DibGuard {
    // DIB 像素存储的起始地址，生命周期随 bitmap
    bits: *mut core::ffi::c_void,
    bitmap: HBITMAP,
}

impl DibGuard {
    fn create_top_down(
        memory_dc: HDC,
        // 像素尺寸，已确认能放进 i32
        width_i32: i32,
        height_i32: i32,
    ) -> Result<Self, HelperError> {
        // 32 位 BI_RGB 不使用调色板，BITMAPINFO 里只需要头部
        let header = BITMAPINFOHEADER {
            // 高度取负表示自上而下，原点在左上角
            biHeight: -height_i32,
            biWidth: width_i32,
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            // 32 位无压缩
            biBitCount: 32,
            biPlanes: 1,
            biCompression: BI_RGB.0,
            // 其余字段对无压缩位图无意义，置 0
            biSizeImage: 0,
            biClrUsed: 0,
            biClrImportant: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
        };
        let info = BITMAPINFO {
            bmiHeader: header,
            bmiColors: [RGBQUAD::default(); 1],
        };

        let mut bits: *mut core::ffi::c_void = core::ptr::null_mut();
        // SAFETY: info 描述一张合法的 32 位自上而下 BGRA DIB；
        // 调用会把像素存储的指针写入 bits，并返回拥有该存储的 HBITMAP，
        // 两者在 Drop 里一并释放。
        let created =
            unsafe { CreateDIBSection(Some(memory_dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) };
        let bitmap = created.map_err(|error| {
            HelperError::CaptureFailed(format!(
                "CreateDIBSection failed: {error} (last error: {})",
                thread_error_text()
            ))
        })?;

        // 即使调用成功，也可能返回非空 HBITMAP 却带着空的像素指针
        // （例如像素缓冲分配失败而头部已分配）。若当成功处理会得到全零画面，
        // 因此在此按 CaptureFailed 报错。
        if bits.is_null() {
            // SAFETY: bitmap 是刚返回的有效 HBITMAP；它还没交给 DibGuard，
            // 必须在此显式删除，以免之后重复释放。
            let _ = unsafe { DeleteObject(HGDIOBJ(bitmap.0)) };
            return Err(HelperError::CaptureFailed(
                "CreateDIBSection returned a null bits pointer".into(),
            ));
        }

        Ok(DibGuard { bits, bitmap })
    }

    /// 像素存储的起始地址。
    fn bits(&self) -> *mut core::ffi::c_void {
        self.bits
    }
}

impl Drop for DibGuard {
    fn drop(&mut self) {
        // SAFETY: bitmap 来自 CreateDIBSection；若曾被选入 DC，
        // 之后声明的 SelectionGuard 已在此之前还原了旧对象。
        let _ = unsafe { DeleteObject(HGDIOBJ(self.bitmap.0)) };
    }
}

/// 还原选入 DIB 之前 DC 里的那个 GDI 对象。
///
/// 它必须声明在 `DibGuard` 之后：按相反顺序析构时，
/// 还原总是先于 `DeleteObject` 完成，哪怕 BitBlt、分配或像素复制失败导致提前返回或展开。
struct SelectionGuard {
    // 已经还原过则析构时不再重复
    released: bool,
    previous: HGDIOBJ,
    hdc: HDC,
}

impl SelectionGuard {
    fn new(hdc: HDC, previous: HGDIOBJ) -> Self {
        SelectionGuard {
            released: false,
            previous,
            hdc,
        }
    }

    fn release(mut self) -> Result<(), HelperError> {
        // SAFETY: hdc 仍由外层 MemoryDcGuard 持有，previous 正是选入 DIB 时返回的对象。
        // 还原失败会向上传播，避免误报抓屏成功；
        // Drop 会在后声明的 DIB 守卫删除位图之前尽力重试。
        let restored = unsafe { SelectObject(self.hdc, self.previous) };
        let refused = restored.0.is_null() || restored.0 as isize == -1;
        if refused {
            return Err(failed_with_last_error(
                "failed to restore previous GDI object",
            ));
        }
        self.released = true;
        Ok(())
    }
}

impl Drop for SelectionGuard {
    fn drop(&mut self) {
        if self.released {
            return;
        }
        // SAFETY: 生命周期约束与 release 相同。Drop 无法上报错误，所以只是尽力而为；
        // 即使传入伪造的无效句柄，Win32 也会正常接受而不会让 Rust 崩溃。
        // 由于声明顺序，这一步会先于 DibGuard::drop 完成。
        let _ = unsafe { SelectObject(self.hdc, self.previous) };
    }
}

/// 检查 (width, height) 的 BGRA 缓冲区不超过 `isize::MAX`，
/// 保证后续 `Vec<u8>` 分配在 64 位目标上不会 panic；成功时返回总字节数。
fn validate_capture_dimensions(width: u32, height: u32) -> Result<usize, HelperError> {
    let w = usize::try_from(width).map_err(|_| {
        HelperError::InvalidDisplay(format!(
            "capture width {width} does not fit in usize on this platform"
        ))
    })?;
    let h = usize::try_from(height).map_err(|_| {
        HelperError::InvalidDisplay(format!(
            "capture height {height} does not fit in usize on this platform"
        ))
    })?;
    let per_row = w.checked_mul(4).ok_or_else(|| {
        HelperError::InvalidDisplay(format!(
            "capture row bytes overflow for width {width} (width*4 > usize::MAX)"
        ))
    })?;
    let total = per_row.checked_mul(h).ok_or_else(|| {
        HelperError::InvalidDisplay(format!(
            "capture pixel buffer overflow for {width}x{height} (4*w*h > usize::MAX)"
        ))
    })?;
    if total > isize::MAX as usize {
        return Err(HelperError::InvalidDisplay(format!(
            "capture pixel buffer {total} exceeds isize::MAX for {width}x{height}"
        )));
    }
    Ok(total)
}

/// GDI 给出的、保持物理（可能已旋转）朝向的原始 BGRA 画面；
/// `freeze` 随后会把它转换为规范朝向。
struct RawBgraCapture {
    pixels: Vec<u8>,
    #[allow(dead_code)]
    pitch: u32,
    height: u32,
    width: u32,
}

fn capture_primary_bgra(display: &DisplayInfo) -> Result<RawBgraCapture, HelperError> {
    let (source_width, source_height) = (display.bounds.width, display.bounds.height);
    if source_width == 0 || source_height == 0 {
        return Err(HelperError::InvalidDisplay(
            "primary display has zero width or height".into(),
        ));
    }
    // 只有像素数超过 2^31 - 1 才会转换失败，单个显示器不可能达到
    let Ok(width_i32) = i32::try_from(source_width) else {
        return Err(HelperError::InvalidDisplay(format!(
            "width {source_width} does not fit in i32"
        )));
    };
    let Ok(height_i32) = i32::try_from(source_height) else {
        return Err(HelperError::InvalidDisplay(format!(
            "height {source_height} does not fit in i32"
        )));
    };

    // 在碰任何 GDI 句柄之前先校验字节数运算：
    // 异常超大的 DisplayInfo 不应先打开屏幕 DC，再因分配 panic 而泄漏它。
    let total_bytes = validate_capture_dimensions(source_width, source_height)?;

    // 按依赖顺序获取守卫；析构顺序相反，任何 `?` 提前返回都会自动释放已取得的资源。
    let screen_dc = ScreenDcGuard::acquire()?;
    let memory_dc = MemoryDcGuard::create(screen_dc.0)?;
    let dib_section = DibGuard::create_top_down(memory_dc.handle(), width_i32, height_i32)?;

    // SelectObject 失败时返回 HGDI_ERROR（即 HGDIOBJ(-1)），按 CaptureFailed 处理，守卫负责清理。
    // SAFETY: memory_dc 与 dib_section.bitmap 都是有效句柄；这里保存旧对象，
    // 以便删除 DIB 之前先还原（Win32 规定不能删除仍被选中的位图）。
    let previous = unsafe { SelectObject(memory_dc.handle(), HGDIOBJ(dib_section.bitmap.0)) };
    if previous.0.is_null() || previous.0 as isize == -1 {
        return Err(failed_with_last_error("SelectObject failed"));
    }
    // 声明顺序不可调换：`selection` 先于 `dib_section` 析构，
    // 这样即便下面提前返回或 panic，也是先还原旧对象再 DeleteObject。
    let selection = SelectionGuard::new(memory_dc.handle(), previous);

    // 带 CAPTUREBLT 以包含分层窗口的内容；系统光标不会被画进抓到的桌面。
    // SAFETY: memory_dc 已选入 DIB，screen_dc 是桌面 DC；
    // 宽高与 DIB 尺寸一致（上面已校验），BitBlt 不会越界读写。
    let (dest_origin, src_origin) = ((0, 0), (0, 0));
    let blt = unsafe {
        BitBlt(
            memory_dc.handle(),
            dest_origin.0,
            dest_origin.1,
            width_i32,
            height_i32,
            Some(screen_dc.0),
            src_origin.0,
            src_origin.1,
            SRCCOPY | CAPTUREBLT,
        )
    };
    if let Err(error) = blt {
        return Err(failed_with_last_error(&format!("BitBlt failed: {error}")));
    }

    // 从 DIB 取出像素。因为 biHeight 为负（自上而下），行紧密排列，pitch 即 width * 4。
    // create_top_down 已拒绝空指针，这里无需再判空。
    let mut pixels = vec![0u8; total_bytes];
    // SAFETY: bits 指向刚分配的 DIB 存储，所有权仍在 dib_section；
    // 读取字节数等于 width * 4 * height，即 total_bytes，
    // 且已由 validate_capture_dimensions 确认不超过 isize::MAX。
    unsafe {
        core::ptr::copy_nonoverlapping(
            dib_section.bits() as *const u8,
            pixels.as_mut_ptr(),
            total_bytes,
        );
    }

    // 显式还原，使还原失败变成结构化的抓屏错误；
    // 出错时 SelectionGuard::drop 会在 DIB 守卫析构前再尽力重试一次。
    selection.release()?;

    Ok(RawBgraCapture {
        pixels,
        pitch: source_width * 4,
        height: source_height,
        width: source_width,
    })
}

/// 返回 (宽, 高, pitch, 像素)，朝向为规范朝向。
fn rotate_to_canonical(
    raw: RawBgraCapture,
    rotation: DisplayRotation,
) -> Result<(u32, u32, u32, Vec<u8>), HelperError> {
    let (source_width, source_height) = (raw.width, raw.height);
    // 90/270 度时宽高互换：GetMonitorInfoW 给出的显示矩形已在规范坐标系里，
    // 而 GDI 缓冲在物理坐标系里，所以旋转时需要交换两个维度。
    let (target_width, target_height) = match rotation {
        DisplayRotation::Rotate90 | DisplayRotation::Rotate270 => (source_height, source_width),
        DisplayRotation::Identity | DisplayRotation::Rotate180 => (source_width, source_height),
    };

    let new_pitch = target_width.checked_mul(4).ok_or_else(|| {
        HelperError::CaptureFailed(format!("pitch overflow for rotated width {target_width}"))
    })?;

    // 旋转之前先确认源像素缓冲长度与预期一致，
    // 防止损坏或恶意的 RawBgraCapture 让旋转函数越界读取。
    let Some(expected_source_bytes) = (source_width as usize)
        .checked_mul(4)
        .and_then(|row| row.checked_mul(source_height as usize))
    else {
        return Err(HelperError::CaptureFailed(format!(
            "raw capture pixel buffer size overflows usize for {source_width}x{source_height}"
        )));
    };
    let actual_bytes = raw.pixels.len();
    if actual_bytes != expected_source_bytes {
        return Err(HelperError::CaptureFailed(format!(
            "raw capture pixel buffer length {actual_bytes} does not match expected {expected_source_bytes} for {source_width}x{source_height}"
        )));
    }

    // 分配目标缓冲之前，先确认其大小不超过 isize::MAX
    validate_capture_dimensions(target_width, target_height)?;

    // 90/270 度的两个函数共用同一组尺寸实参
    let src = (source_width, source_height);
    let dst = (target_width, target_height);
    let pixels = match rotation {
        DisplayRotation::Identity => raw.pixels,
        DisplayRotation::Rotate180 => rotate_180(&raw.pixels, src.0, src.1),
        DisplayRotation::Rotate90 => rotate_clockwise(&raw.pixels, src.0, src.1, dst.0, dst.1),
        DisplayRotation::Rotate270 => {
            rotate_counter_clockwise(&raw.pixels, src.0, src.1, dst.0, dst.1)
        }
    };

    Ok((target_width, target_height, new_pitch, pixels))
}

/// 通用的逐像素重排：对目标的每个 (x, y)，由 `source_of` 给出源像素所在的 (列, 行)。
fn remap_pixels(
    pixels: &[u8],
    source_width: usize,
    target_width: usize,
    target_height: usize,
    source_of: impl Fn(usize, usize) -> (usize, usize),
) -> Vec<u8> {
    let mut out = vec![0u8; target_width * 4 * target_height];
    for y in 0..target_height {
        for x in 0..target_width {
            let (col, row) = source_of(x, y);
            let from = (row * source_width + col) * 4;
            let to = (y * target_width + x) * 4;
            out[to..to + 4].copy_from_slice(&pixels[from..from + 4]);
        }
    }
    out
}

fn rotate_180(pixels: &[u8], width: u32, height: u32) -> Vec<u8> {
    let (w, h) = (width as usize, height as usize);
    // 右下角像素变成左上角，其余依此类推
    remap_pixels(pixels, w, w, h, |x, y| (w - 1 - x, h - 1 - y))
}

fn rotate_clockwise(
    pixels: &[u8],
    // 源图尺寸
    source_width: u32,
    source_height: u32,
    // 目标图尺寸（宽高已互换）
    target_width: u32,
    target_height: u32,
) -> Vec<u8> {
    // 顺时针 90 度要求目标宽 == 源高、目标高 == 源宽。
    // 目标 (x, y) 取自源的第 (src_h - 1 - x) 行、第 y 列。
    let (src_w, src_h) = (source_width as usize, source_height as usize);
    let (dst_w, dst_h) = (target_width as usize, target_height as usize);
    debug_assert_eq!(
        (src_h, src_w),
        (dst_w, dst_h),
        "CW rotation requires swapped dimensions"
    );
    remap_pixels(pixels, src_w, dst_w, dst_h, |x, y| (y, src_h - 1 - x))
}

fn rotate_counter_clockwise(
    pixels: &[u8],
    // 源图尺寸
    source_width: u32,
    source_height: u32,
    // 目标图尺寸（宽高已互换）
    target_width: u32,
    target_height: u32,
) -> Vec<u8> {
    // 逆时针 90 度（即顺时针 270 度），维度约束与顺时针相同。
    // 目标 (x, y) 取自源的第 x 行、第 (src_w - 1 - y) 列。
    let (src_w, src_h) = (source_width as usize, source_height as usize);
    let (dst_w, dst_h) = (target_width as usize, target_height as usize);
    debug_assert_eq!(
        (src_w, src_h),
        (dst_h, dst_w),
        "CCW rotation requires swapped dimensions"
    );
    remap_pixels(pixels, src_w, dst_w, dst_h, |x, y| (src_w - 1 - y, x))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 四个互不相同的像素，按 [左上, 右上, 左下, 右下] 排布成 2x2 图像
    fn quad_image() -> (Vec<u8>, [[u8; 4]; 4]) {
        let cells = [
            [1, 2, 3, 4],
            [5, 6, 7, 8],
            [9, 10, 11, 12],
            [13, 14, 15, 16],
        ];
        (cells.concat(), cells)
    }

    #[test]
    fn selection_guard_drop_is_best_effort_for_invalid_previous_object() {
        let bogus_object = HGDIOBJ((-1isize) as *mut core::ffi::c_void);
        drop(SelectionGuard::new(HDC::default(), bogus_object));
    }

    #[test]
    fn rotate_180_reverses_rows_and_columns() {
        let (image, [tl, tr, bl, br]) = quad_image();
        let turned = rotate_180(&image, 2, 2);
        // 旋转后：右下到左上，左下到右上，右上到左下，左上到右下
        assert_eq!(turned, [br, bl, tr, tl].concat());
    }

    #[test]
    fn rotate_clockwise_swaps_dimensions_and_rotates_pixel() {
        let (image, [tl, tr, bl, br]) = quad_image();
        let turned = rotate_clockwise(&image, 2, 2, 2, 2);
        // 顺时针后的第一行是源的第一列自下向上读取：[bl, tl]，第二行 [br, tr]
        assert_eq!(turned, [bl, tl, br, tr].concat());
    }

    #[test]
    fn rotate_counter_clockwise_swaps_dimensions_and_rotates_pixel() {
        let (image, [tl, tr, bl, br]) = quad_image();
        let turned = rotate_counter_clockwise(&image, 2, 2, 2, 2);
        // 逆时针后：第一行 [tr, br]，第二行 [tl, bl]
        assert_eq!(turned, [tr, br, tl, bl].concat());
    }

    #[test]
    fn rotate_clockwise_into_wider_target_uses_swap_dimensions() {
        // 源为 2 列 4 行，旋转后得到 4 列 2 行。
        // 左列像素的蓝色分量依次为 10..13，右列为 20..23。
        let column_zero = |row: u8| [10 + row, 0, 0, 255];
        let column_one = |row: u8| [20 + row, 0, 0, 255];
        let mut image = Vec::new();
        for row in 0..4u8 {
            image.extend_from_slice(&column_zero(row));
            image.extend_from_slice(&column_one(row));
        }

        let turned = rotate_clockwise(&image, 2, 4, 4, 2);
        assert_eq!(turned.len(), 4 * 4 * 2);
        // 目标第 0 行读取源的第 0 列，从最后一行向上；第 1 行读取第 1 列
        let expected: Vec<u8> = (0..4u8)
            .rev()
            .map(column_zero)
            .chain((0..4u8).rev().map(column_one))
            .flatten()
            .collect();
        assert_eq!(turned, expected);
    }

    #[test]
    fn solid_bgra_helper_is_well_formed() {
        let filled = [0xABu8; 3 * 4 * 2];
        assert_eq!(filled.len(), 3 * 4 * 2);
        assert!(filled.iter().all(|byte| *byte == 0xAB));
    }

    #[test]
    fn validate_capture_dimensions_rejects_overflow() {
        // i32::MAX x i32::MAX 个像素、每像素 4 字节，远超任何平台的 isize::MAX，
        // 若直接 `vec![0u8; total]` 会 panic。校验必须把它转成 InvalidDisplay 错误，
        // 否则 panic 还会让桌面 DC 泄漏。
        let verdict = validate_capture_dimensions(i32::MAX as u32, i32::MAX as u32);
        match verdict {
            Err(HelperError::InvalidDisplay(_)) => {}
            other => panic!("overflow must surface as InvalidDisplay, got {other:?}"),
        }
    }

    #[test]
    fn validate_capture_dimensions_accepts_a_normal_1080p_monitor() {
        // 1920x1080 只有约 8MB，必须通过
        validate_capture_dimensions(1920, 1080).expect("1920x1080 must pass dimension validation");
    }

    #[test]
    fn rotate_to_canonical_rejects_mismatched_pixel_length() {
        // 声称 4x4 却只有 3 字节的画面必须提前拒绝，
        // 否则旋转函数会因越界而 panic；rotate_to_canonical 是这里的测试入口。
        let bogus = RawBgraCapture {
            pixels: vec![1, 2, 3],
            pitch: 16,
            height: 4,
            width: 4,
        };
        match rotate_to_canonical(bogus, DisplayRotation::Identity) {
            Err(HelperError::CaptureFailed(_)) => {}
            other => panic!("mismatched length must surface as CaptureFailed, got {other:?}"),
        }
    }
}
