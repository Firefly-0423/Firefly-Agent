//! 把选区写入剪贴板（`CF_DIBV5` 格式）。
//!
//! helper 将用户在冻结画面上的选区作为 `CF_DIBV5`（第 5 版设备无关位图）发布到
//! Windows 剪贴板。画图、浏览器、聊天客户端以及多数富文本编辑器都能直接接受该格式，
//! 所以 `clipboard-only` 提交不必经过编码器，也不会往 PNG 输出目录写文件。
//!
//! 数据布局：
//!   * 一个 `BITMAPV5HEADER`，描述 32 bpp 的 BGRA 位图，
//!     使用 `BI_BITFIELDS` 通道掩码（红 `0x00FF0000`、绿 `0x0000FF00`、蓝 `0x000000FF`）
//!     与 sRGB 色彩空间；头部之后紧跟紧密排列的像素行（pitch = width * 4）。
//!   * 头部里的高度取选区高度的相反数，行则按自下而上的顺序写入。
//!
//! 失败时的处理：
//!   * `OpenClipboard` 失败（剪贴板被别的进程占用）直接返回错误，
//!     调用方据此上报 `clipboardWritten: false`。
//!   * `GlobalAlloc` 得到的句柄由 `HGLOBALGuard` 看管，
//!     只有 `SetClipboardData` 成功之后系统才拥有它，此前出错都会确定性地释放。
//!   * 在 `EmptyClipboard` 与成功的 `SetClipboardData` 之间出现任何错误，
//!     守卫析构时都会用 `GlobalFree` 释放该内存并返回错误。

use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
use windows::Win32::Graphics::Gdi::{BI_BITFIELDS, BITMAPV5HEADER, CIEXYZTRIPLE};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalUnlock};
use windows::Win32::System::Ole::CF_DIBV5;
use windows::core::Free;

use crate::{error::HelperError, win::capture::CpuBgraFrame};

/// `bV5CSType` 里表示 sRGB 色彩空间的取值（小端的 "sRGB"）。
#[allow(non_upper_case_globals)]
const LCS_sRGB: u32 = 0x7352_4742;

fn clip_failure(text: impl Into<String>) -> HelperError {
    HelperError::CaptureFailed(text.into())
}

/// 看管 `GlobalAlloc` 返回的 `HGLOBAL`：析构时释放，
/// 除非所有权已经通过 `SetClipboardData` 交给剪贴板（此时先调用 `disarm`）。
/// 释放走 `windows_core::Free`，与 windows crate 里其它 Free 实现一致。
struct HGLOBALGuard {
    armed: bool,
    handle: HGLOBAL,
}

impl HGLOBALGuard {
    fn new(handle: HGLOBAL) -> Self {
        HGLOBALGuard {
            armed: true,
            handle,
        }
    }

    /// 放弃看管并取回句柄（所有权已转给系统时调用）。
    fn disarm(mut self) -> HGLOBAL {
        self.armed = false;
        self.handle
    }
}

impl Drop for HGLOBALGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        // SAFETY: 句柄来自 GlobalAlloc 且从未交给 SetClipboardData
        // （否则早已 disarm）。Free 的实现内部调用 GlobalFree。
        unsafe { self.handle.free() };
    }
}

/// 看管已打开的剪贴板：析构时调用 CloseClipboard，
/// 即使中途 panic 也不会让其他进程遇到悬挂的剪贴板状态。
struct OpenClipboardGuard;

impl Drop for OpenClipboardGuard {
    fn drop(&mut self) {
        // SAFETY: OpenClipboard 在同一线程调用过，CloseClipboard 是它的配对操作。
        // 若关闭失败，说明已被别处关掉，可以放心忽略。
        let _ = unsafe { CloseClipboard() };
    }
}

/// 位图数据各部分的字节数。
struct DibLayout {
    width: i32,
    height: i32,
    header_bytes: u32,
    row_bytes: u32,
    pixel_bytes: u32,
    total_bytes: usize,
}

impl DibLayout {
    fn measure(frame: &CpuBgraFrame) -> Result<Self, HelperError> {
        let (w, h) = (frame.width, frame.height);
        let width = i32::try_from(w)
            .map_err(|_| clip_failure(format!("clipboard width {w} does not fit in i32")))?;
        let height = i32::try_from(h)
            .map_err(|_| clip_failure(format!("clipboard height {h} does not fit in i32")))?;

        let row_bytes = w
            .checked_mul(4)
            .ok_or_else(|| clip_failure(format!("clipboard row bytes overflow for width {w}")))?;
        let pixel_bytes = row_bytes
            .checked_mul(h)
            .ok_or_else(|| clip_failure(format!("clipboard pixel buffer overflow for {w}x{h}")))?;
        let header_bytes = u32::try_from(std::mem::size_of::<BITMAPV5HEADER>())
            .map_err(|_| clip_failure("BITMAPV5HEADER size overflow"))?;
        let total_u32 = header_bytes.checked_add(pixel_bytes).ok_or_else(|| {
            clip_failure(format!(
                "clipboard total bytes overflow ({header_bytes} + {pixel_bytes})"
            ))
        })?;
        let total_bytes = usize::try_from(total_u32).map_err(|_| {
            clip_failure(format!(
                "clipboard total bytes {total_u32} does not fit in usize"
            ))
        })?;

        Ok(DibLayout {
            width,
            height,
            header_bytes,
            row_bytes,
            pixel_bytes,
            total_bytes,
        })
    }

    fn header(&self) -> BITMAPV5HEADER {
        BITMAPV5HEADER {
            // 图像尺寸与格式；高度为负，与渲染器缓存使用的 GDI DIB 约定保持一致
            bV5Size: self.header_bytes,
            bV5Width: self.width,
            bV5Height: -self.height,
            bV5Planes: 1,
            bV5BitCount: 32,
            bV5Compression: BI_BITFIELDS,
            bV5SizeImage: self.pixel_bytes,
            // 通道掩码：BGRA
            bV5AlphaMask: 0xFF00_0000,
            bV5RedMask: 0x00FF_0000,
            bV5GreenMask: 0x0000_FF00,
            bV5BlueMask: 0x0000_00FF,
            // 色彩空间用 sRGB，没有内嵌配置文件
            bV5CSType: LCS_sRGB,
            bV5Endpoints: CIEXYZTRIPLE::default(),
            bV5Intent: 0,
            bV5ProfileData: 0,
            bV5ProfileSize: 0,
            bV5GammaRed: 0,
            bV5GammaGreen: 0,
            bV5GammaBlue: 0,
            // 分辨率、调色板与保留位均不使用
            bV5XPelsPerMeter: 0,
            bV5YPelsPerMeter: 0,
            bV5ClrUsed: 0,
            bV5ClrImportant: 0,
            bV5Reserved: 0,
        }
    }
}

/// 把一帧 CPU BGRA 画面以 `CF_DIBV5` 写入 Windows 剪贴板。
///
/// `hwnd` 是 helper 持有剪贴板期间的所有者窗口；传入覆盖窗口，
/// 即便用户在粘贴之前点到别处，剪贴板仍与 helper 进程关联。
///
/// 返回 `Ok(())` 表示传给系统的 HGLOBAL 已由剪贴板接管，
/// 直到用户复制其他内容之前都由剪贴板持有。失败时不会留下任何已发布的数据
/// （中间状态都已回滚）。
pub fn write_cf_dibv5(hwnd: HWND, frame: &CpuBgraFrame) -> Result<(), HelperError> {
    if frame.width == 0 || frame.height == 0 {
        return Err(clip_failure("cannot write an empty frame to the clipboard"));
    }
    // pitch 小于 width * 4 说明源行比一个 BGRA 行还短，复制时必然越过缓冲区末尾；
    // 而 pitch 大于 width * 4 是正常的（例如 GPU 抓屏按 4 字节对齐行），所以只拒绝过小的情况。
    let min_row_bytes = frame.width.checked_mul(4).ok_or_else(|| {
        clip_failure(format!(
            "clipboard row bytes overflow for width {}",
            frame.width
        ))
    })?;
    if frame.pitch < min_row_bytes {
        return Err(clip_failure(format!(
            "clipboard frame pitch {} is below width*4={}",
            frame.pitch, min_row_bytes
        )));
    }

    // 其他进程占用剪贴板时 OpenClipboard 会失败，
    // 调用方会把它映射为 `clipboardWritten: false` 并继续提交流程。
    // SAFETY: 传入 Some(hwnd) 使剪贴板归属于我们的窗口，
    // 后续 SetClipboardData 在提交期间不会被别的进程抢占。
    unsafe { OpenClipboard(Some(hwnd)) }
        .map_err(|error| clip_failure(format!("OpenClipboard failed: {error}")))?;
    let _open = OpenClipboardGuard;

    // SAFETY: 刚在本线程打开了剪贴板，EmptyClipboard 是文档规定的下一步，
    // 会清掉之前遗留的内容。
    unsafe { EmptyClipboard() }
        .map_err(|error| clip_failure(format!("EmptyClipboard failed: {error}")))?;

    // 总大小 = BITMAPV5HEADER + width * 4 * height 的像素
    let layout = DibLayout::measure(frame)?;

    // SAFETY: GMEM_MOVEABLE 返回可重定位内存块的句柄；该 HGLOBAL 由本函数持有，
    // 只会经 SetClipboardData 交出去，在那之前由 HGLOBALGuard 记录所有权。
    let block = unsafe { GlobalAlloc(GMEM_MOVEABLE, layout.total_bytes) }
        .map_err(|error| clip_failure(format!("GlobalAlloc failed: {error}")))?;
    let block_guard = HGLOBALGuard::new(block);

    // SAFETY: GlobalLock 固定内存块并返回可写指针；这个句柄只有我们持有锁，
    // 按文档要求会在 SetClipboardData 之前解锁。
    let base = unsafe { GlobalLock(block) };
    if base.is_null() {
        return Err(clip_failure("GlobalLock returned a null pointer"));
    }

    // SAFETY: base 指向 total_bytes 大小的可写内存；先写头部，再写 BGRA 像素
    // （自下而上），每行字节数等于 width * 4。
    unsafe {
        std::ptr::write(base as *mut BITMAPV5HEADER, layout.header());

        let pixels_out = (base as *mut u8).add(layout.header_bytes as usize);
        let row_len = layout.row_bytes as usize;
        let src_pitch = frame.pitch as usize;
        let last_row = frame.height as usize - 1;
        for out_row in 0..frame.height as usize {
            // DIB 的第 0 行放图像最底下的一行
            let from_row = last_row - out_row;
            std::ptr::copy_nonoverlapping(
                frame.pixels.as_ptr().add(from_row * src_pitch),
                pixels_out.add(out_row * row_len),
                row_len.min(src_pitch),
            );
        }
    }

    // SAFETY: 指针取自同一句柄的 GlobalLock，按文档要求在 SetClipboardData 之前解锁。
    unsafe {
        let _ = GlobalUnlock(block);
    }

    // 把所有权交给剪贴板。SetClipboardData 成功后内存归系统，必须 disarm 守卫以免重复释放；
    // 若此处失败（说明写入途中剪贴板被夺走），守卫析构会释放缓冲，不会泄漏。
    // SAFETY: block 是已填好数据的有效 GMEM_MOVEABLE 块。windows crate 的签名用 HANDLE，
    // 这里把句柄按 HANDLE 重新解释，二者都是同一个内核句柄的指针宽度封装。
    let accepted = unsafe { SetClipboardData(CF_DIBV5.0 as u32, Some(HANDLE(block.0))) }
        .map_err(|error| clip_failure(format!("SetClipboardData failed: {error}")))?;
    if accepted.is_invalid() {
        return Err(clip_failure("SetClipboardData returned an invalid handle"));
    }

    // 所有权已转移，disarm 之后守卫的析构不再做任何事
    let _handed_over = block_guard.disarm();
    Ok(())
}
