//! 抓屏后端的抽象层。
//!
//! 其余代码只通过 [`CaptureBackend`] 取得主显示器的冻结画面。
//! 首选实现是 DXGI Desktop Duplication（[`crate::win::capture_dxgi`]）；
//! [`crate::win::capture_gdi::GdiCaptureBackend`] 作为后备，
//! 在 DXGI 初始化失败或系统把光标合成进桌面时启用。

use windows::Win32::Graphics::Direct3D11::{
    D3D11_BOX, D3D11_CPU_ACCESS_READ, D3D11_MAP_READ, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
    ID3D11Texture2D,
};
use windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};

use crate::error::HelperError;
use crate::geometry::{DisplayRotation, RectI};
use crate::win::display::DisplayInfo;

/// 冻结画面的 BGRA 像素，来自 GDI，或来自 GPU 路径拷到内存的 Direct3D 暂存纹理。
///
/// `pitch` 是每行字节数，可能大于 `width * 4`（GDI 的 DIB 行按 4 字节对齐）。
/// 像素始终是规范朝向：生成 [`CpuBgraFrame`] 时旋转已经被抵消，
/// 调用方无需关心物理显示器的旋转。
#[derive(Clone, Debug)]
pub struct CpuBgraFrame {
    /// 像素宽度
    pub width: u32,
    /// 像素高度
    pub height: u32,
    /// 每行字节数
    pub pitch: u32,
    /// BGRA 像素数据，共 `pitch * height` 字节以内
    pub pixels: Vec<u8>,
}

/// DXGI 抓屏路径产出的 GPU 冻结帧句柄。
///
/// 画面留在 GPU 上，直到用户确认选区才用一次很小的
/// `CopySubresourceRegion` + `Map` 只读回选区。冻结纹理与它的 D2D 位图
/// 在整个交互期间保持存在，[`crate::win::renderer::OverlayRenderer`] 绑定该位图，
/// 之后的重绘不会再次上传整帧。
///
/// COM 类型不在抽象层之外暴露，使 trait 面向 UI 线程的用法保持 `Send` 友好。
#[derive(Debug)]
pub struct GpuFrozenFrame {
    /// 规范朝向下的宽度
    pub(crate) width: u32,
    /// 规范朝向下的高度
    pub(crate) height: u32,
    /// 抓取时显示器的旋转角度
    #[allow(dead_code)]
    pub(crate) rotation: DisplayRotation,
    /// 原始（未旋转）的冻结纹理。
    pub(crate) frozen: ID3D11Texture2D,
    /// 与规范 `display.bounds` 对应、已按显示朝向摆正的纹理。
    pub(crate) frozen_oriented: Option<ID3D11Texture2D>,
    pub(crate) device: windows::Win32::Graphics::Direct3D11::ID3D11Device,
    pub(crate) context: windows::Win32::Graphics::Direct3D11::ID3D11DeviceContext,
}

impl GpuFrozenFrame {
    /// 把冻结纹理（优先用摆正后的）整帧读回 CPU。
    /// 仅在 D2D 位图上传失败时作为后备使用；它会产生整帧读回，
    /// 所以走到这里之后不应再断言 `full_frame_cpu_readbacks == 0`。
    pub fn readback_to_cpu(&self) -> Result<CpuBgraFrame, HelperError> {
        let (width, height) = (self.width, self.height);
        let pixels = self.copy_into_cpu("readback_to_cpu", width, height, None)?;
        Ok(CpuBgraFrame {
            width,
            height,
            pitch: width * 4,
            pixels,
        })
    }

    /// 只读回冻结纹理中的一块区域（坐标为规范显示坐标），
    /// 返回帧的尺寸等于 `rect`，避免整帧读回。
    pub fn readback_selection(&self, rect: RectI) -> Result<CpuBgraFrame, HelperError> {
        if rect.width == 0 || rect.height == 0 {
            return Err(HelperError::CaptureFailed(
                "readback_selection called with zero-sized rect".into(),
            ));
        }

        let left = rect.x as u32;
        let top = rect.y as u32;
        let region = D3D11_BOX {
            left,
            top,
            front: 0,
            right: left + rect.width,
            bottom: top + rect.height,
            back: 1,
        };
        let pixels =
            self.copy_into_cpu("readback_selection", rect.width, rect.height, Some(&region))?;
        Ok(CpuBgraFrame {
            width: rect.width,
            height: rect.height,
            pitch: rect.width * 4,
            pixels,
        })
    }

    /// 两种读回共用的流程：建 STAGING 纹理、拷贝（整张或子区域）、Map、逐行复制。
    /// `label` 只用于错误信息的前缀。
    fn copy_into_cpu(
        &self,
        label: &str,
        width: u32,
        height: u32,
        region: Option<&D3D11_BOX>,
    ) -> Result<Vec<u8>, HelperError> {
        let fail = |detail: String| HelperError::CaptureFailed(format!("{label} {detail}"));

        let row_bytes = (width as usize)
            .checked_mul(4)
            .ok_or_else(|| fail("row overflow".into()))?;
        let total_bytes = row_bytes
            .checked_mul(height as usize)
            .ok_or_else(|| fail("total overflow".into()))?;

        // 单层、单个 BGRA 纹理，只允许 CPU 读取
        let desc = D3D11_TEXTURE2D_DESC {
            Usage: D3D11_USAGE_STAGING,
            CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
            BindFlags: 0,
            MiscFlags: 0,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC {
                Quality: 0,
                Count: 1,
            },
            ArraySize: 1,
            MipLevels: 1,
            Height: height,
            Width: width,
        };
        let mut created: Option<ID3D11Texture2D> = None;
        // SAFETY: desc 描述的是一张合法的 STAGING 纹理。
        unsafe { self.device.CreateTexture2D(&desc, None, Some(&mut created)) }
            .map_err(|e| fail(format!("CreateTexture2D failed: {e}")))?;
        let staging = created.ok_or_else(|| fail("CreateTexture2D returned None".into()))?;

        let source = self.frozen_oriented.as_ref().unwrap_or(&self.frozen);
        // SAFETY: 整张拷贝时尺寸一致；子区域拷贝时 region 落在源纹理内。
        unsafe {
            match region {
                None => self.context.CopyResource(&staging, source),
                Some(area) => {
                    self.context
                        .CopySubresourceRegion(&staging, 0, 0, 0, 0, source, 0, Some(area))
                }
            }
        }

        let mut mapped = Default::default();
        // SAFETY: 对 STAGING 纹理以 READ 方式 Map 是合法的。
        unsafe {
            self.context
                .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
        }
        .map_err(|e| fail(format!("Map failed: {e}")))?;

        let src_pitch = mapped.RowPitch as usize;
        let copy_len = row_bytes.min(src_pitch);
        let mut pixels = vec![0u8; total_bytes];
        // SAFETY: 逐行复制，长度取两侧行宽中较小者，Map 期间 pData 有效。
        unsafe {
            let base = mapped.pData as *const u8;
            for row in 0..height as usize {
                std::ptr::copy_nonoverlapping(
                    base.add(row * src_pitch),
                    pixels.as_mut_ptr().add(row * row_bytes),
                    copy_len,
                );
            }
        }
        // SAFETY: 读取完毕后解除映射。
        unsafe { self.context.Unmap(&staging, 0) };

        Ok(pixels)
    }
}

/// [`CaptureBackend::freeze`] 成功时的结果。
#[derive(Debug)]
pub enum FrozenFrame {
    /// 画面留在 GPU 上（DXGI）
    Gpu(GpuFrozenFrame),
    /// 画面已在内存中（GDI，或 GPU 读回后的结果）
    Cpu(CpuBgraFrame),
}

/// [`CaptureBackend::refresh_latest`] 的返回结果。
///
/// GDI 是按需拉取，只会返回 `Unchanged`；
/// `Updated` 与 `Lost` 由自带持续帧缓冲的后端（DXGI duplication）产生。
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RefreshOutcome {
    /// 取得了新画面
    Updated,
    /// 画面没有变化
    Unchanged,
    /// duplication 已失效，需要重建
    Lost,
}

/// 用来证明 GPU 路径兑现承诺的计数器：从 `Start` 到 `overlay-visible`
/// 之间没有整屏 CPU 读回，提交时恰好一次选区读回。
///
/// 字段是单调累加的计数，经 `Event::OverlayVisible` 与 `Event::CaptureReleased`
/// 发到协议上，集成测试因此无需私有检查接口就能验证这些约定。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDiagnostics {
    /// 协议上显示的后端标识，例如 `"dxgi"`、`"gdi"`。
    pub backend: &'static str,
    /// 把整屏大小的缓冲读回 CPU 的 `Map`/`BitBlt` 总次数。
    /// DXGI 在 `Start` 与 `overlay-visible` 之间必须保持为 0。
    pub full_frame_cpu_readbacks: u64,
    /// 读回选区（或更小区域）的 `Map`/`BitBlt` 总次数，两种后端都在提交时累加。
    pub selection_cpu_readbacks: u64,
    /// `AcquireNextFrame` 返回 `S_OK`（DXGI）或冻结成功（GDI）的次数；
    /// GDI 在首次冻结时记 1。
    pub latest_copies: u64,
    /// DXGI duplication 与纹理被重建的次数（ACCESS_LOST、显示器或 DPI 变化）；
    /// 正常桌面下为 0。
    pub duplication_rebuilds: u64,
}

/// 抓屏后端需要提供的能力。
///
/// 当前 helper 只在单线程内使用后端，实现应保持 `Send` 安全，
/// 但不要假定 `Sync`；唯一的使用者是 UI 线程。
pub trait CaptureBackend {
    /// 后端的稳定名称，会作为 [`CaptureDiagnostics::backend`] 发到协议上。
    fn name(&self) -> &'static str;

    /// 刷新后端认为的最新画面，并说明这一帧是新的、没变还是已丢失。
    /// `timeout_ms` 只是提示，GDI 后端忽略它。
    fn refresh_latest(&mut self, timeout_ms: u32) -> Result<RefreshOutcome, HelperError>;

    /// 重建与显示器拓扑或图形设备绑定的资源。DXGI 会替换 duplication 与纹理池，
    /// 按需拉取的后端可以保持原状。
    fn recover(&mut self, _display: &DisplayInfo) -> Result<(), HelperError> {
        Ok(())
    }

    /// 冻结主显示器当前画面，得到尺寸与规范朝向下 `display.bounds` 一致的 [`FrozenFrame`]。
    /// 调用方传入 `display`，以便后端施加所需的旋转变换。
    fn freeze(&mut self, display: &DisplayInfo) -> Result<FrozenFrame, HelperError>;

    /// 丢弃后端持有的持久状态，使下一次冻结重新抓取。
    /// 没有持久状态的后端可以什么也不做。
    fn invalidate(&mut self);

    /// 取得当前计数快照；返回值是 `Copy`，读取不会影响后端内部状态。
    fn diagnostics(&self) -> CaptureDiagnostics;

    /// 记录一次选区 CPU 读回，调用方在从冻结帧里取出选区之后调用，
    /// 使诊断计数与实际读回保持一致。
    fn record_selection_readback(&mut self);

    /// 刚取得的 DXGI 帧是否无法满足 helper 的光标策略，
    /// 为真时本次抓屏会话应改用 GDI。
    fn should_fallback_to_gdi(&self) -> bool {
        false
    }
}

/// 冻结帧的规范尺寸；帧里任一边为 0 时退回显示器自身的宽高。
/// `OverlayApp` 用它来确定 D2D 位图大小，免得再去读 `display.bounds`。
pub fn frozen_canonical_bounds(frozen: &FrozenFrame, display_bounds: RectI) -> (u32, u32) {
    let (w, h) = match frozen {
        FrozenFrame::Cpu(cpu) => (cpu.width, cpu.height),
        FrozenFrame::Gpu(gpu) => (gpu.width, gpu.height),
    };
    if w != 0 && h != 0 {
        (w, h)
    } else {
        (display_bounds.width, display_bounds.height)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_default_is_all_zero() {
        let blank = CaptureDiagnostics::default();
        assert_eq!(blank.backend, "");
        let counters = [
            blank.full_frame_cpu_readbacks,
            blank.selection_cpu_readbacks,
            blank.latest_copies,
            blank.duplication_rebuilds,
        ];
        assert_eq!(counters, [0; 4]);
    }

    #[test]
    fn refresh_outcome_is_copy() {
        let first = RefreshOutcome::Unchanged;
        let second = first;
        assert_eq!(first, second);
    }

    #[test]
    fn refresh_outcome_variants_are_distinct() {
        use RefreshOutcome::{Lost, Unchanged, Updated};
        for (a, b) in [(Updated, Unchanged), (Updated, Lost), (Unchanged, Lost)] {
            assert_ne!(a, b);
        }
    }
}
