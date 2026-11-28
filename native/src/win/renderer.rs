//! Frozen desktop presentation and annotation rendering for the overlay.
use windows::core::{
    w,
    Interface
};

use windows::Win32::Foundation::{
    HWND,
    RECT,
    COLORREF
};

use windows::Win32::Graphics::{
    Direct2D::{
        Common as D2D,
        ID2D1Factory,
        ID2D1Device,
        ID2D1DeviceContext,
        ID2D1RenderTarget,
        ID2D1DCRenderTarget,
        ID2D1Bitmap1,
        ID2D1Image,
        ID2D1SolidColorBrush,
        ID2D1StrokeStyle,
        D2D1CreateFactory,
        D2D1CreateDevice,
        D2D1_FACTORY_TYPE_SINGLE_THREADED,
        D2D1_BITMAP_PROPERTIES1,
        D2D1_BITMAP_OPTIONS_NONE,
        D2D1_BITMAP_OPTIONS_TARGET,
        D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
        D2D1_INTERPOLATION_MODE_LINEAR,
        D2D1_STROKE_STYLE_PROPERTIES,
        D2D1_CAP_STYLE_ROUND,
        D2D1_LINE_JOIN_ROUND,
        D2D1_DASH_STYLE_SOLID,
        D2D1_ROUNDED_RECT,
        D2D1_DRAW_TEXT_OPTIONS_NONE,
        D2D1_RENDER_TARGET_PROPERTIES,
        D2D1_RENDER_TARGET_TYPE_DEFAULT,
        D2D1_RENDER_TARGET_USAGE_NONE,
        D2D1_FEATURE_LEVEL_DEFAULT,
    },
    DirectWrite::{
        IDWriteFactory,
        IDWriteFontCollection,
        IDWriteTextFormat,
        DWriteCreateFactory,
        DWRITE_FACTORY_TYPE_SHARED,
        DWRITE_FONT_WEIGHT_NORMAL,
        DWRITE_FONT_STYLE_NORMAL,
        DWRITE_FONT_STRETCH_NORMAL,
        DWRITE_MEASURING_MODE_NATURAL,
    },
    Direct3D11::{
        ID3D11Device,
        ID3D11Texture2D
    },
    Dxgi::{
        IDXGIDevice,
        IDXGIAdapter,
        IDXGISurface,
        IDXGISwapChain1,
        DXGI_SWAP_CHAIN_DESC1,
        DXGI_SWAP_CHAIN_FLAG,
        DXGI_SCALING_STRETCH,
        DXGI_SWAP_EFFECT_FLIP_DISCARD,
        DXGI_USAGE_RENDER_TARGET_OUTPUT,
        DXGI_PRESENT,
        Common::{
            DXGI_FORMAT_B8G8R8A8_UNORM,
            DXGI_ALPHA_MODE_IGNORE,
            DXGI_SAMPLE_DESC
        },
    },
    Dwm::DwmFlush,
    Gdi::{
        HDC,
        HBITMAP,
        HGDIOBJ,
        HPEN,
        GetDC,
        ReleaseDC,
        CreateCompatibleDC,
        DeleteDC,
        CreateDIBSection,
        DeleteObject,
        SelectObject,
        BitBlt,
        SRCCOPY,
        BITMAPINFO,
        BITMAPINFOHEADER,
        BI_RGB,
        DIB_RGB_COLORS,
        CreatePen,
        PS_SOLID,
        CreateSolidBrush,
        GetStockObject,
        NULL_BRUSH,
        Rectangle,
        FillRect,
        MoveToEx,
        LineTo,
        SetBkMode,
        TRANSPARENT,
        SetTextColor,
        TextOutW,
        BLENDFUNCTION,
        AC_SRC_OVER,
        AC_SRC_ALPHA,
        AlphaBlend,
        UpdateWindow,
    },
};

use windows_numerics::Vector2;

use crate::error::HelperError;

use crate::geometry::{
    AnnotationTool,
    AnnotationColor,
    RectI,
    Mark,
    place_toolbar
};

use crate::win::{
    capture::{
        CpuBgraFrame,
        GpuFrozenFrame
    },
    display::DisplayInfo,
    window::{
        OverlayWindow,
        TOOLBAR_WIDTH,
        TOOLBAR_HEIGHT,
        TOOLBAR_GAP,
        TOOLBAR_BUTTON_GAP
    },
};

/// 选区工具栏里每个可点区域的位置，均为窗口坐标。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolbarLayout {
    /// 整条工具栏的外框。
    pub toolbar: RectI,
    /// 四个颜色色块，从左到右对应 AnnotationColor 的顺序。
    pub colors: [RectI; 4],
    /// 左侧三个工具：矩形、箭头、撤销。
    pub rectangle: RectI,
    pub arrow: RectI,
    pub undo: RectI,
    /// 右端的取消与确认。
    pub cancel: RectI,
    pub confirm: RectI,
}

/// Direct2D 呈现链。字段按声明顺序释放：先断开设备上下文，再放交换链，最后放冻结位图。
struct GpuPresenter {
    context: Option<ID2D1DeviceContext>,
    buffers: Option<IDXGISwapChain1>,
    frozen: Option<ID2D1Bitmap1>,
    /// 当前交换链或冻结位图的像素尺寸（宽, 高）。
    size: (u32, u32),
}

/// 遮罩窗口的绘制器。释放顺序：CPU 缓存 → GPU 呈现链 → D2D 工厂 → 字体。
pub struct OverlayRenderer {
    gdi_cache: Option<GdiFrameCache>,
    gpu: GpuPresenter,
    factory: Option<ID2D1Factory>,
    label_font: Option<IDWriteTextFormat>,
    pub d2d_available: bool,
    /// 累计上传冻结帧的次数，清空缓存不会归零（供诊断计数）。
    pub upload_count: u64,
}

struct GdiFrameCache {
    columns: i32,
    rows: i32,
    source_bitmap: HBITMAP,
    mem_dc: HDC,
    source_saved: HGDIOBJ,
    staging_bitmap: HBITMAP,
    staging_dc: HDC,
    staging_saved: HGDIOBJ,
}

impl GdiFrameCache {
    fn composition_hdc(&self) -> HDC {
        self.staging_dc
    }
}

impl Drop for GdiFrameCache {
    fn drop(&mut self) {
        // Restore selections before deleting either bitmap.
        unsafe {
            _ = SelectObject(self.staging_dc, self.staging_saved);
            _ = DeleteObject(HGDIOBJ(self.staging_bitmap.0));
            _ = DeleteDC(self.staging_dc);
            _ = SelectObject(self.mem_dc, self.source_saved);
            _ = DeleteObject(HGDIOBJ(self.source_bitmap.0));
            _ = DeleteDC(self.mem_dc);
        }
    }
}

impl Drop for OverlayRenderer {
    fn drop(&mut self) {
        self.clear_frozen();
    }
}

impl OverlayRenderer {
    pub fn new() -> Result<Self, HelperError> {
        let drawing_factory = unsafe {
            D2D1CreateFactory::<ID2D1Factory>(D2D1_FACTORY_TYPE_SINGLE_THREADED, None)
        }.ok();
        let font = unsafe {
            DWriteCreateFactory::<IDWriteFactory>(DWRITE_FACTORY_TYPE_SHARED)
        }.ok().and_then(
            |writer| unsafe {
                let normal_weight = DWRITE_FONT_WEIGHT_NORMAL;
                writer.CreateTextFormat(
                    w!("Segoe UI"),
                    None::<&IDWriteFontCollection>,
                    normal_weight,
                    DWRITE_FONT_STYLE_NORMAL,
                    DWRITE_FONT_STRETCH_NORMAL,
                    16.0,
                    w!("zh-CN")
                ).ok()
            }
        );
        Ok(
            Self {
                gdi_cache: None,
                gpu: GpuPresenter { context: None, buffers: None, frozen: None, size: (0, 0) },
                d2d_available: drawing_factory.is_some(),
                factory: drawing_factory,
                label_font: font,
                upload_count: 0,
            }
        )
    }

    pub fn init_gpu_resources(
        &mut self,
        capture_device: &ID3D11Device,
        overlay_handle: HWND,
        monitor: &DisplayInfo
    ) -> Result<(), HelperError> {
        let _factory_ref = self.factory.as_ref().ok_or_else(
            || HelperError::CaptureFailed("cannot init GPU resources without D2D factory".into())
        )?;
        let graphics: IDXGIDevice = capture_device.cast().map_err(
            |error| HelperError::CaptureFailed(format!("D3D11 device cast to IDXGIDevice failed: {error}"))
        )?;
        let drawing: ID2D1Device = unsafe {
            D2D1CreateDevice(&graphics, None)
        }.map_err(|error| HelperError::CaptureFailed(format!("D2D1CreateDevice failed: {error}")))?;
        let painter = unsafe {
            drawing.CreateDeviceContext( windows::Win32::Graphics::Direct2D::D2D1_DEVICE_CONTEXT_OPTIONS_NONE)
        }.map_err(
            |error| HelperError::CaptureFailed(format!("ID2D1Device::CreateDeviceContext failed: {error}"))
        )?;
        let adapter: IDXGIAdapter = unsafe {
            graphics.GetParent()
        }.map_err(
            |error| HelperError::CaptureFailed(format!("IDXGIDevice::GetParent failed: {error}"))
        )?;
        let owner: windows::Win32::Graphics::Dxgi::IDXGIFactory2 = unsafe {
            adapter.GetParent()
        }.map_err(
            |error| HelperError::CaptureFailed(format!("IDXGIAdapter::GetParent failed: {error}"))
        )?;
        let description = DXGI_SWAP_CHAIN_DESC1 {
            Width: monitor.bounds.width,
            Height: monitor.bounds.height,
            SampleDesc: DXGI_SAMPLE_DESC {
                Count: 1,
                Quality: 0
            },
            BufferCount: 2,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
            SwapEffect: DXGI_SWAP_EFFECT_FLIP_DISCARD,
            Scaling: DXGI_SCALING_STRETCH,
            AlphaMode: DXGI_ALPHA_MODE_IGNORE,
            Stereo: false.into(),
            Flags: 0,
        };
        let buffers = unsafe {
            owner.CreateSwapChainForHwnd(capture_device, overlay_handle, &description, None, None)
        }.map_err(
            |error| HelperError::CaptureFailed(format!("CreateSwapChainForHwnd failed: {error}"))
        )?;
        self.gpu.context = Some(painter);
        self.gpu.buffers = Some(buffers);
        self.gpu.size = (monitor.bounds.width, monitor.bounds.height);
        Ok(())
    }

    pub fn resize(&mut self, _overlay_handle: HWND, monitor: &DisplayInfo) -> Result<(), HelperError> {
        if let Some(buffers) = &self.gpu.buffers {
            unsafe {
                buffers.ResizeBuffers(
                    0,
                    monitor.bounds.width,
                    monitor.bounds.height,
                    DXGI_FORMAT_B8G8R8A8_UNORM,
                    DXGI_SWAP_CHAIN_FLAG(0)
                )
            }.map_err(|error| HelperError::CaptureFailed(format!("ResizeBuffers failed: {error}")))?;
        }
        self.discard_cpu_frame();
        Ok(())
    }

    pub fn upload_frozen_gpu(
        &mut self,
        frozen_frame: &GpuFrozenFrame,
        overlay_handle: HWND,
        monitor: &DisplayInfo
    ) -> Result<(), HelperError> {
        if self.gpu.context.is_none() {
            self.init_gpu_resources(&frozen_frame.device, overlay_handle, monitor)?;
        }
        let oriented = frozen_frame.frozen_oriented.as_ref().unwrap_or(&frozen_frame.frozen);
        let shared_surface: IDXGISurface = oriented.cast().map_err(
            |error| HelperError::CaptureFailed(format!("ID3D11Texture2D cast to IDXGISurface failed: {error}"))
        )?;
        let painter = self.gpu.context.as_ref().ok_or_else( || HelperError::CaptureFailed("D2D device context not initialized".into()))?;
        let description = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: opaque_pixel_format(),
            bitmapOptions: D2D1_BITMAP_OPTIONS_NONE,
            dpiX: 96.0,
            colorContext: core::mem::ManuallyDrop::new(None),
            dpiY: 96.0,
        };
        let frozen = unsafe {
            painter.CreateBitmapFromDxgiSurface(&shared_surface, Some(&description))
        }.map_err(
            |error| HelperError::CaptureFailed(format!("CreateBitmapFromDxgiSurface failed: {error}"))
        )?;
        self.gpu.frozen = Some(frozen);
        self.gpu.size = (frozen_frame.width, frozen_frame.height);
        self.upload_count = self.upload_count.saturating_add(1);
        Ok(())
    }

    pub fn upload_frozen(&mut self, frozen_frame: &CpuBgraFrame) -> Result<(), HelperError> {
        self.discard_cpu_frame();
        let cached = create_gdi_frame_cache(frozen_frame)?;
        self.gdi_cache = Some(cached);
        self.upload_count = self.upload_count.saturating_add(1);
        Ok(())
    }

    pub fn clear_frozen(&mut self) {
        self.discard_cpu_frame();
        self.gpu.frozen = None;
        if let Some(painter) = &self.gpu.context {
            unsafe {
                painter.SetTarget(None::<&ID2D1Image>);
            }
        }
    }

    pub fn reset_gpu_resources(&mut self) {
        self.clear_frozen();
        // Release the context before releasing its swap chain.
        self.gpu.context = None;
        self.gpu.buffers = None;
        self.gpu.size = (0, 0);
    }

    pub fn paint(
        &self,
        overlay_handle: HWND,
        selected_area: Option<RectI>,
        monitor: &DisplayInfo,
        toolbar_layout: Option<ToolbarLayout>
    ) -> Result<(), HelperError> {
        match (self.gpu.frozen.is_some(), self.gpu.buffers.is_some()) {
            (true, true) => self.paint_d2d(
                overlay_handle,
                selected_area,
                monitor,
                toolbar_layout,
                &[],
                None,
                false,
                None,
                AnnotationColor::Red
            ),
            _ => self.paint_gdi_fallback(overlay_handle, selected_area, monitor, toolbar_layout),
        }
    }

    pub fn paint_on_hdc(
        &self,
        hdc: HDC,
        overlay_handle: HWND,
        selected_area: Option<RectI>,
        monitor: &DisplayInfo,
        toolbar_layout: Option<ToolbarLayout>,
        saved_marks: &[Mark],
        pending_mark: Option<Mark>,
        palette_open: bool,
        selected_tool: Option<AnnotationTool>,
        selected_color: AnnotationColor
    ) -> Result<(), HelperError> {
        if self.gpu.frozen.is_some() && self.gpu.buffers.is_some() {
            return self.paint_d2d(
                overlay_handle,
                selected_area,
                monitor,
                toolbar_layout,
                saved_marks,
                pending_mark,
                palette_open,
                selected_tool,
                selected_color
            );
        }
        let destination = self.gdi_cache.as_ref().map_or(hdc, GdiFrameCache::composition_hdc);
        paint_gdi_on_hdc(destination, self.gdi_cache.as_ref(), selected_area, monitor, toolbar_layout)?;
        let detailed = self.draw_overlay_details_d2d_on_hdc(
            destination,
            monitor,
            selected_area,
            toolbar_layout,
            saved_marks,
            pending_mark,
            palette_open,
            selected_tool,
            selected_color
        );
        if let Err(error) = detailed {
            eprintln!(
                "firefly-screenshot: D2D-on-GDI overlay details failed ({error}), using basic GDI"
            );
            if let Some(panel) = toolbar_layout {
                draw_toolbar_gdi(destination, panel)?;
            }
            draw_overlay_details_gdi(
                destination,
                selected_area,
                toolbar_layout,
                saved_marks,
                pending_mark,
                palette_open,
                selected_tool,
                selected_color
            )?;
        }
        if let Some(backing) = &self.gdi_cache {
            unsafe {
                _ = BitBlt(
                    hdc,
                    0,
                    0,
                    backing.columns,
                    backing.rows,
                    Some(backing.staging_dc),
                    0,
                    0,
                    SRCCOPY
                );
            }
        }
        Ok(())
    }

    fn paint_d2d(
        &self,
        _overlay_handle: HWND,
        selected_area: Option<RectI>,
        monitor: &DisplayInfo,
        toolbar_layout: Option<ToolbarLayout>,
        saved_marks: &[Mark],
        pending_mark: Option<Mark>,
        palette_open: bool,
        selected_tool: Option<AnnotationTool>,
        selected_color: AnnotationColor
    ) -> Result<(), HelperError> {
        let painter = self.gpu.context.as_ref().ok_or_else( || HelperError::CaptureFailed("D2D context missing in paint_d2d".into()))?;
        let buffers = self.gpu.buffers.as_ref().ok_or_else( || HelperError::CaptureFailed("swap chain missing in paint_d2d".into()))?;
        let output: ID3D11Texture2D = unsafe {
            buffers.GetBuffer::<ID3D11Texture2D>(0)
        }.map_err(|error| HelperError::CaptureFailed(format!("GetBuffer(0) failed: {error}")))?;
        let output_surface: IDXGISurface = output.cast().map_err(
            |error| HelperError::CaptureFailed(format!("back buffer cast to IDXGISurface failed: {error}"))
        )?;
        let output_description = D2D1_BITMAP_PROPERTIES1 {
            pixelFormat: opaque_pixel_format(),
            bitmapOptions: D2D1_BITMAP_OPTIONS_TARGET | D2D1_BITMAP_OPTIONS_CANNOT_DRAW,
            dpiX: 96.0,
            colorContext: core::mem::ManuallyDrop::new(None),
            dpiY: 96.0,
        };
        let output_bitmap = unsafe {
            painter.CreateBitmapFromDxgiSurface(&output_surface, Some(&output_description))
        }.map_err(
            |error| HelperError::CaptureFailed( format!( "CreateBitmapFromDxgiSurface for back buffer failed: {error}"))
        )?;
        let shade_rgba = D2D::D2D1_COLOR_F {
            r: 0.0,
            g: 0.0,
            b: 0.0,
            a: 0.45
        };
        let shade = unsafe {
            painter.CreateSolidColorBrush(&shade_rgba, None)
        }.map_err(HelperError::from)?;
        let outline_rgba = D2D::D2D1_COLOR_F {
            a: 1.0,
            r: 0x3e as f32 / 255.0,
            g: 0xea as f32 / 255.0,
            b: 0x96 as f32 / 255.0,
        };
        let outline = unsafe {
            painter.CreateSolidColorBrush(&outline_rgba, None)
        }.map_err(HelperError::from)?;
        unsafe {
            painter.SetTarget(&output_bitmap);
            painter.BeginDraw();
            let opaque_black = D2D::D2D1_COLOR_F {
                r: 0.0,
                g: 0.0,
                b: 0.0,
                a: 1.0
            };
            painter.Clear(Some(&opaque_black));
        }
        let extent_x = monitor.bounds.width as f32;
        let extent_y = monitor.bounds.height as f32;
        if let Some(desktop) = &self.gpu.frozen {
            let area = D2D::D2D_RECT_F {
                left: 0.0,
                top: 0.0,
                right: extent_x,
                bottom: extent_y
            };
            unsafe {
                painter.DrawBitmap( desktop, Some(&area), 1.0, D2D1_INTERPOLATION_MODE_LINEAR, None, None);
            }
        }
        for outside in dim_regions(monitor.bounds.width, monitor.bounds.height, selected_area) {
            unsafe {
                painter.FillRectangle(&d2d_rect(outside), &shade);
            }
        }
        if let Some(chosen) = selected_area {
            unsafe {
                painter.DrawRectangle(&d2d_rect(chosen), &outline, 2.0, None::<&ID2D1StrokeStyle>);
            }
        }
        self.draw_overlay_details_d2d(
            painter,
            selected_area,
            toolbar_layout,
            saved_marks,
            pending_mark,
            palette_open,
            selected_tool,
            selected_color
        )?;
        let finished = unsafe {
            painter.EndDraw(None, None)
        }.map_err(|error| HelperError::CaptureFailed(format!("EndDraw failed: {error}")));
        unsafe {
            painter.SetTarget(None::<&ID2D1Image>);
        }
        finished?;
        unsafe {
            buffers.Present(1, DXGI_PRESENT(0))
        }.ok().map_err(
            |error| HelperError::CaptureFailed(format!("IDXGISwapChain1::Present failed: {error}"))
        )?;
        Ok(())
    }

    fn draw_overlay_details_d2d(
        &self,
        target: &ID2D1RenderTarget,
        selected_area: Option<RectI>,
        toolbar_layout: Option<ToolbarLayout>,
        saved_marks: &[Mark],
        pending_mark: Option<Mark>,
        palette_open: bool,
        selected_tool: Option<AnnotationTool>,
        selected_color: AnnotationColor
    ) -> Result<(), HelperError> {
        let owner = self.factory.as_ref().ok_or_else(
            || HelperError::CaptureFailed("D2D factory missing while drawing overlay".into())
        )?;
        let stroke = unsafe {
            owner.CreateStrokeStyle(
                &D2D1_STROKE_STYLE_PROPERTIES {
                    startCap: D2D1_CAP_STYLE_ROUND,
                    lineJoin: D2D1_LINE_JOIN_ROUND,
                    endCap: D2D1_CAP_STYLE_ROUND,
                    miterLimit: 10.0,
                    dashCap: D2D1_CAP_STYLE_ROUND,
                    dashStyle: D2D1_DASH_STYLE_SOLID,
                    dashOffset: 0.0,
                },
                None
            )
        }.map_err(HelperError::from)?;
        let accent = d2d_brush(target, 0x3e, 0xea, 0x96, 0xff)?;
        for annotation in saved_marks.iter().copied().chain(pending_mark) {
            draw_mark_d2d(target, annotation, &stroke)?;
        }
        if let Some(chosen) = selected_area {
            for (horizontal, vertical) in selection_handle_centers(chosen) {
                let square = D2D::D2D_RECT_F {
                    left: horizontal as f32 - 4.0,
                    top: vertical as f32 - 4.0,
                    right: horizontal as f32 + 5.0,
                    bottom: vertical as f32 + 5.0,
                };
                unsafe {
                    target.FillRectangle(&square, &accent);
                }
            }
            if let Some(font) = &self.label_font {
                let caption: Vec<u16> = format!("{} x {}", chosen.width, chosen.height).encode_utf16().collect();
                let baseline = match chosen.y >= 24 {
                    true => chosen.y as f32 - 24.0,
                    false => chosen.y as f32 + 6.0,
                };
                let caption_area = D2D::D2D_RECT_F {
                    left: chosen.x as f32,
                    top: baseline,
                    right: chosen.x as f32 + 180.0,
                    bottom: baseline + 22.0,
                };
                let foreground = d2d_brush(target, 0xff, 0xff, 0xff, 0xff)?;
                unsafe {
                    target.DrawText(
                        &caption,
                        font,
                        &caption_area,
                        &foreground,
                        D2D1_DRAW_TEXT_OPTIONS_NONE,
                        DWRITE_MEASURING_MODE_NATURAL
                    );
                }
            }
        }
        if let Some(panel) = toolbar_layout {
            let paper = d2d_brush(target, 0xf7, 0xf7, 0xf7, 0xff)?;
            let edge = d2d_brush(target, 0xd8, 0xd8, 0xd8, 0xff)?;
            let shape = rounded_box(panel.toolbar, 8.0);
            unsafe {
                target.FillRoundedRectangle(&shape, &paper);
                target.DrawRoundedRectangle(&shape, &edge, 1.0, None::<&ID2D1StrokeStyle>);
            }
            let highlighted = selected_tool.map(
                |tool| match tool {
                    AnnotationTool::Rectangle => panel.rectangle,
                    AnnotationTool::Arrow => panel.arrow,
                }
            );
            if let Some(button_area) = highlighted {
                let pressed = d2d_brush(target, 0xe8, 0xe8, 0xe8, 0xff)?;
                let pressed_shape = rounded_box(inset(button_area, 4), 6.0);
                unsafe {
                    target.FillRoundedRectangle(&pressed_shape, &pressed);
                }
            }
            let ink = d2d_brush(target, 0x33, 0x33, 0x33, 0xff)?;
            draw_svg_toolbar_icons_d2d(target, owner, panel, &ink, &stroke)?;
            if palette_open {
                let palette_area = RectI {
                    x: panel.colors[0].x - 8,
                    y: panel.colors[0].y - 8,
                    width: u32::try_from(
                        panel.colors[3].x.saturating_add_unsigned(panel.colors[3].width).saturating_sub(panel.colors[0].x).saturating_add(16)
                    ).unwrap_or_default(),
                    height: panel.colors[0].height + 16,
                };
                let palette_shape = rounded_box(palette_area, 8.0);
                unsafe {
                    target.FillRoundedRectangle(&palette_shape, &paper);
                }
                for (swatch_area, hue) in panel.colors.into_iter().zip(
                    [
                        AnnotationColor::Red,
                        AnnotationColor::Yellow,
                        AnnotationColor::Green,
                        AnnotationColor::Blue,
                    ]
                ) {
                    let pigment = d2d_annotation_brush(target, hue)?;
                    let swatch_shape = rounded_box(inset(swatch_area, 4), 10.0);
                    unsafe {
                        target.FillRoundedRectangle(&swatch_shape, &pigment);
                    }
                    if hue == selected_color {
                        unsafe {
                            target.DrawRoundedRectangle(&swatch_shape, &ink, 2.0, None::<&ID2D1StrokeStyle>);
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn draw_overlay_details_d2d_on_hdc(
        &self,
        hdc: HDC,
        monitor: &DisplayInfo,
        selected_area: Option<RectI>,
        toolbar_layout: Option<ToolbarLayout>,
        saved_marks: &[Mark],
        pending_mark: Option<Mark>,
        palette_open: bool,
        selected_tool: Option<AnnotationTool>,
        selected_color: AnnotationColor
    ) -> Result<(), HelperError> {
        let owner = self.factory.as_ref().ok_or_else(
            || HelperError::CaptureFailed("D2D factory unavailable for GDI overlay details".into())
        )?;
        let destination: ID2D1DCRenderTarget = unsafe {
            owner.CreateDCRenderTarget(
                &D2D1_RENDER_TARGET_PROPERTIES {
                    r#type: D2D1_RENDER_TARGET_TYPE_DEFAULT,
                    minLevel: D2D1_FEATURE_LEVEL_DEFAULT,
                    pixelFormat: opaque_pixel_format(),
                    usage: D2D1_RENDER_TARGET_USAGE_NONE,
                    dpiY: 96.0,
                    dpiX: 96.0,
                }
            )
        }.map_err(HelperError::from)?;
        let extent = RECT {
            left: 0,
            top: 0,
            right: i32::try_from(monitor.bounds.width).map_err( |_| HelperError::InvalidDisplay("D2D DC target width does not fit i32".into()))?,
            bottom: i32::try_from(monitor.bounds.height).map_err( |_| HelperError::InvalidDisplay("D2D DC target height does not fit i32".into()))?,
        };
        unsafe {
            destination.BindDC(hdc, &extent).map_err(HelperError::from)?;
            destination.BeginDraw();
        }
        let painted = self.draw_overlay_details_d2d(
            &destination,
            selected_area,
            toolbar_layout,
            saved_marks,
            pending_mark,
            palette_open,
            selected_tool,
            selected_color
        );
        // EndDraw still runs when the detail pass failed.
        let completed = unsafe {
            destination.EndDraw(None, None)
        }.map_err(HelperError::from);
        painted.and(completed)
    }

    fn paint_gdi_fallback(
        &self,
        overlay_handle: HWND,
        selected_area: Option<RectI>,
        monitor: &DisplayInfo,
        toolbar_layout: Option<ToolbarLayout>
    ) -> Result<(), HelperError> {
        let destination = unsafe {
            GetDC(Some(overlay_handle))
        };
        if destination.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        let painted = paint_gdi_on_hdc(destination, self.gdi_cache.as_ref(), selected_area, monitor, toolbar_layout);
        unsafe {
            _ = ReleaseDC(Some(overlay_handle), destination);
        }
        painted
    }

    pub fn flush(&self) -> Result<(), HelperError> {
        unsafe {
            DwmFlush().map_err(HelperError::from)
        }
    }

    pub fn extract_selection(&self, crop: RectI, gpu_frame: Option<&GpuFrozenFrame>) -> Result<CpuBgraFrame, HelperError> {
        if crop.width == 0 || crop.height == 0 {
            return Err(
                HelperError::CaptureFailed("extract_selection called with zero-sized rect".into())
            );
        }
        if self.gdi_cache.is_none() && self.gpu.frozen.is_some() {
            return match gpu_frame {
                Some(texture_frame) => texture_frame.readback_selection(crop),
                None => Err(
                    HelperError::CaptureFailed( "extract_selection: GPU bitmap set but no GpuFrozenFrame provided".into())
                ),
            };
        }
        let backing = self.gdi_cache.as_ref().ok_or_else(
            || HelperError::CaptureFailed( "extract_selection called without an active frozen cache".into())
        )?;
        let cache_w = u32::try_from(backing.columns).map_err(
            |_| HelperError::CaptureFailed( format!("frozen cache width {} does not fit in u32", backing.columns))
        )?;
        let cache_h = u32::try_from(backing.rows).map_err(
            |_| HelperError::CaptureFailed( format!("frozen cache height {} does not fit in u32", backing.rows))
        )?;
        if crop.x < 0 || crop.y < 0 {
            return Err(
                HelperError::CaptureFailed( format!( "selection origin ({},{}) must be non-negative", crop.x, crop.y))
            );
        }
        if crop.x as u64 + crop.width as u64 > cache_w as u64 || crop.y as u64 + crop.height as u64 > cache_h as u64 {
            return Err(
                HelperError::CaptureFailed( format!( "selection {:?} exceeds cached frozen frame {cache_w}x{cache_h}", crop))
            );
        }
        let span_x = i32::try_from(crop.width).map_err(
            |_| HelperError::CaptureFailed( format!("selection width {} does not fit in i32", crop.width))
        )?;
        let span_y = i32::try_from(crop.height).map_err(
            |_| HelperError::CaptureFailed( format!("selection height {} does not fit in i32", crop.height))
        )?;
        // Keep this name inside the diagnostic to preserve its exact text.
        let row_bytes = (crop.width as usize).checked_mul(4).and_then(|stride| stride.checked_mul(crop.height as usize)).ok_or_else(|| HelperError::CaptureFailed("selection pixel buffer overflow".into()))?;
        if row_bytes > isize::MAX as usize {
            return Err(
                HelperError::CaptureFailed( format!( "selection pixel buffer {row_bytes} exceeds isize::MAX"))
            );
        }
        let mut owned_pixels = vec![0u8; row_bytes];
        let desktop_dc = ScreenDcGuard::acquire()?;
        let destination_dc = MemoryDcGuard::create(desktop_dc.hdc())?;
        let destination_bitmap = BitmapGuard::create_dib_top_down(destination_dc.hdc(), span_x, span_y)?;
        let saved_bitmap = unsafe {
            SelectObject(destination_dc.hdc(), HGDIOBJ(destination_bitmap.bitmap.0))
        };
        if saved_bitmap.0.is_null() || saved_bitmap.0 as isize == -1 {
            return Err(
                HelperError::CaptureFailed(
                    format!(
                        "SelectObject for selection extraction failed (last error: {})",
                        windows::core::Error::from_thread().message()
                    )
                )
            );
        }
        let _restore = SelectionGuard::new(destination_dc.hdc(), saved_bitmap);
        let copied = unsafe {
            BitBlt(
                destination_dc.hdc(),
                0,
                0,
                span_x,
                span_y,
                Some(backing.mem_dc),
                crop.x,
                crop.y,
                SRCCOPY
            )
        };
        if let Err(error) = copied {
            return Err(
                HelperError::CaptureFailed(format!("BitBlt for selection extraction failed: {error}"))
            );
        }
        let source_bytes = destination_bitmap.bits();
        unsafe {
            std::ptr::copy_nonoverlapping(source_bytes as *const u8, owned_pixels.as_mut_ptr(), row_bytes);
        }
        Ok(
            CpuBgraFrame {
                width: crop.width,
                height: crop.height,
                pitch: crop.width * 4,
                pixels: owned_pixels
            }
        )
    }

    fn discard_cpu_frame(&mut self) {
        self.gdi_cache = None;
    }
}



fn opaque_pixel_format() -> D2D::D2D1_PIXEL_FORMAT {
    D2D::D2D1_PIXEL_FORMAT {
        alphaMode: D2D::D2D1_ALPHA_MODE_IGNORE,
        format: DXGI_FORMAT_B8G8R8A8_UNORM,
    }
}

fn selection_handle_centers(area: RectI) -> [(i32, i32); 8] {
    let far_x = area.x.saturating_add_unsigned(area.width);
    let far_y = area.y.saturating_add_unsigned(area.height);
    let mid_x = area.x + i32::try_from(area.width / 2).unwrap_or_default();
    let mid_y = area.y + i32::try_from(area.height / 2).unwrap_or_default();
    [
        (area.x, area.y),
        (mid_x, area.y),
        (far_x, area.y),
        (far_x, mid_y),
        (far_x, far_y),
        (mid_x, far_y),
        (area.x, far_y),
        (area.x, mid_y)
    ]
}

fn rounded_box(area: RectI, curvature: f32) -> D2D1_ROUNDED_RECT {
    D2D1_ROUNDED_RECT {
        rect: d2d_rect(area),
        radiusX: curvature,
        radiusY: curvature
    }
}

fn d2d_rect(area: RectI) -> D2D::D2D_RECT_F {
    D2D::D2D_RECT_F {
        left: area.x as f32,
        top: area.y as f32,
        right: area.x.saturating_add_unsigned(area.width) as f32,
        bottom: area.y.saturating_add_unsigned(area.height) as f32,
    }
}

fn d2d_brush(target: &ID2D1RenderTarget, r8: u8, g8: u8, b8: u8, a8: u8) -> Result<ID2D1SolidColorBrush, HelperError> {
    let rgba = D2D::D2D1_COLOR_F {
        r: f32::from(r8) / 255.0,
        g: f32::from(g8) / 255.0,
        b: f32::from(b8) / 255.0,
        a: f32::from(a8) / 255.0,
    };
    unsafe {
        target.CreateSolidColorBrush(&rgba, None)
    }.map_err(HelperError::from)
}

fn d2d_annotation_brush(target: &ID2D1RenderTarget, hue: AnnotationColor) -> Result<ID2D1SolidColorBrush, HelperError> {
    let [b8, g8, r8, a8] = annotation_bgra(hue);
    d2d_brush(target, r8, g8, b8, a8)
}

fn vector(horizontal: f32, vertical: f32) -> Vector2 {
    Vector2 {
        X: horizontal,
        Y: vertical
    }
}

fn arrow_unit(from: (i32, i32), to: (i32, i32)) -> (f64, f64) {
    let horizontal = f64::from(to.0 - from.0);
    let vertical = f64::from(to.1 - from.1);
    let magnitude = (horizontal * horizontal + vertical * vertical).sqrt().max(1.0);
    (horizontal / magnitude, vertical / magnitude)
}

fn draw_mark_d2d(target: &ID2D1RenderTarget, annotation: Mark, stroke: &ID2D1StrokeStyle) -> Result<(), HelperError> {
    let (from, to, hue, pointed) = (annotation.start, annotation.end, annotation.color, annotation.is_arrow());
    let pigment = d2d_annotation_brush(target, hue)?;
    unsafe {
        if pointed {
            target.DrawLine(
                vector(from.x as f32, from.y as f32),
                vector(to.x as f32, to.y as f32),
                &pigment,
                3.0,
                stroke
            );
            let (unit_x, unit_y) = arrow_unit((from.x, from.y), (to.x, to.y));
            for direction in [-1.0, 1.0] {
                let tip_x = (f64::from(to.x) - unit_x * 12.0 + (-unit_y) * 6.0 * direction) as f32;
                let tip_y = (f64::from(to.y) - unit_y * 12.0 + unit_x * 6.0 * direction) as f32;
                target.DrawLine( vector(to.x as f32, to.y as f32), vector(tip_x, tip_y), &pigment, 3.0, stroke);
            }
        } else {
            let outline = D2D::D2D_RECT_F {
                left: from.x.min(to.x) as f32,
                top: from.y.min(to.y) as f32,
                right: from.x.max(to.x) as f32,
                bottom: from.y.max(to.y) as f32,
            };
            target.DrawRectangle(&outline, &pigment, 3.0, stroke);
        }
    }
    Ok(())
}

fn svg_icon_point(area: RectI, horizontal: f32, vertical: f32) -> Vector2 {
    let offset_x = area.x as f32 + (area.width as f32 - 24.0) / 2.0;
    let offset_y = area.y as f32 + (area.height as f32 - 24.0) / 2.0;
    vector(offset_x + horizontal * 0.5, offset_y + vertical * 0.5)
}

fn icon_segment(
    target: &ID2D1RenderTarget,
    area: RectI,
    from: (f32, f32),
    to: (f32, f32),
    pigment: &ID2D1SolidColorBrush,
    stroke: &ID2D1StrokeStyle
) {
    unsafe {
        target.DrawLine(
            svg_icon_point(area, from.0, from.1),
            svg_icon_point(area, to.0, to.1),
            pigment,
            2.0,
            stroke
        );
    }
}

fn draw_svg_toolbar_icons_d2d(
    target: &ID2D1RenderTarget,
    owner: &ID2D1Factory,
    panel: ToolbarLayout,
    pigment: &ID2D1SolidColorBrush,
    stroke: &ID2D1StrokeStyle
) -> Result<(), HelperError> {
    let box_shape = D2D1_ROUNDED_RECT {
        rect: D2D::D2D_RECT_F {
            left: svg_icon_point(panel.rectangle, 4.0, 8.0).X,
            top: svg_icon_point(panel.rectangle, 4.0, 8.0).Y,
            right: svg_icon_point(panel.rectangle, 44.0, 40.0).X,
            bottom: svg_icon_point(panel.rectangle, 44.0, 40.0).Y,
        },
        radiusX: 1.0,
        radiusY: 1.0,
    };
    unsafe {
        target.DrawRoundedRectangle(&box_shape, pigment, 2.0, stroke);
    }
    for (from, to) in [
        ((19.0, 11.0), (37.0, 11.0)),
        ((37.0, 11.0), (37.0, 29.0)),
        ((11.5439, 36.4559), (36.9997, 11.0)),
    ] {
        icon_segment(target, panel.arrow, from, to, pigment, stroke);
    }
    draw_undo_svg_d2d(target, owner, panel.undo, pigment, stroke)?;
    for (from, to) in [((8.0, 8.0), (40.0, 40.0)), ((8.0, 40.0), (40.0, 8.0))] {
        icon_segment(target, panel.cancel, from, to, pigment, stroke);
    }
    for (from, to) in [((43.0, 11.0), (16.875, 37.0)), ((16.875, 37.0), (5.0, 25.1818))] {
        icon_segment(target, panel.confirm, from, to, pigment, stroke);
    }
    Ok(())
}

fn draw_undo_svg_d2d(
    target: &ID2D1RenderTarget,
    owner: &ID2D1Factory,
    area: RectI,
    pigment: &ID2D1SolidColorBrush,
    stroke: &ID2D1StrokeStyle
) -> Result<(), HelperError> {
    let path = unsafe {
        owner.CreatePathGeometry()
    }.map_err(HelperError::from)?;
    let writer = unsafe {
        path.Open()
    }.map_err(HelperError::from)?;
    unsafe {
        writer.BeginFigure(svg_icon_point(area, 11.2721, 36.7279), D2D::D2D1_FIGURE_BEGIN_HOLLOW);
        let curves = [
            [(14.5294, 39.9853), (19.0294, 42.0), (24.0, 42.0)],
            [(33.9411, 42.0), (42.0, 33.9411), (42.0, 24.0)],
            [(42.0, 14.0589), (33.9411, 6.0), (24.0, 6.0)],
            [(19.0294, 6.0), (14.5294, 8.01472), (11.2721, 11.2721)],
            [(9.61407, 12.9301), (6.0, 17.0), (6.0, 17.0)],
        ];
        for [control_a, control_b, endpoint] in curves {
            writer.AddBezier(
                &D2D::D2D1_BEZIER_SEGMENT {
                    point1: svg_icon_point(area, control_a.0, control_a.1),
                    point2: svg_icon_point(area, control_b.0, control_b.1),
                    point3: svg_icon_point(area, endpoint.0, endpoint.1),
                }
            );
        }
        writer.EndFigure(D2D::D2D1_FIGURE_END_OPEN);
        writer.BeginFigure(svg_icon_point(area, 6.0, 9.0), D2D::D2D1_FIGURE_BEGIN_HOLLOW);
        writer.AddLines(&[svg_icon_point(area, 6.0, 17.0), svg_icon_point(area, 14.0, 17.0)]);
        writer.EndFigure(D2D::D2D1_FIGURE_END_OPEN);
        writer.Close().map_err(HelperError::from)?;
        target.DrawGeometry(&path, pigment, 2.0, stroke);
    }
    Ok(())
}

pub fn burn_annotations(
    image: &mut CpuBgraFrame,
    annotations: &[Mark],
    selection_origin: crate::geometry::PointI
) {
    for annotation in annotations {
        let (from, to, hue, pointed) = (annotation.start, annotation.end, annotation.color, annotation.is_arrow());
        let local_from = (
            from.x.saturating_sub(selection_origin.x),
            from.y.saturating_sub(selection_origin.y)
        );
        let local_to = ( to.x.saturating_sub(selection_origin.x), to.y.saturating_sub(selection_origin.y));
        let pigment = annotation_bgra(hue);
        if pointed {
            draw_bgra_line(image, local_from, local_to, pigment, 3);
            let (unit_x, unit_y) = arrow_unit(local_from, local_to);
            for direction in [-1.0, 1.0] {
                let tail = (
                    (f64::from(local_to.0) - unit_x * 12.0 + (-unit_y) * 6.0 * direction).round() as i32,
                    (f64::from(local_to.1) - unit_y * 12.0 + unit_x * 6.0 * direction).round() as i32,
                );
                draw_bgra_line(image, local_to, tail, pigment, 3);
            }
        } else {
            let min_x = local_from.0.min(local_to.0);
            let min_y = local_from.1.min(local_to.1);
            let max_x = local_from.0.max(local_to.0);
            let max_y = local_from.1.max(local_to.1);
            for (edge_from, edge_to) in [
                ((min_x, min_y), (max_x, min_y)),
                ((max_x, min_y), (max_x, max_y)),
                ((max_x, max_y), (min_x, max_y)),
                ((min_x, max_y), (min_x, min_y)),
            ] {
                draw_bgra_line(image, edge_from, edge_to, pigment, 3);
            }
        }
    }
}

fn draw_bgra_line(
    image: &mut CpuBgraFrame,
    from: (i32, i32),
    to: (i32, i32),
    pigment: [u8; 4],
    weight: i32
) {
    let half_weight = weight.max(1) as f64 / 2.0;
    let margin = half_weight.ceil() as i32 + 1;
    let min_x = from.0.min(to.0).saturating_sub(margin);
    let min_y = from.1.min(to.1).saturating_sub(margin);
    let max_x = from.0.max(to.0).saturating_add(margin);
    let max_y = from.1.max(to.1).saturating_add(margin);
    let horizontal = f64::from(to.0 - from.0);
    let vertical = f64::from(to.1 - from.1);
    let norm_squared = horizontal * horizontal + vertical * vertical;
    for row in min_y..=max_y {
        for column in min_x..=max_x {
            let sample_x = f64::from(column) + 0.5;
            let sample_y = f64::from(row) + 0.5;
            let position = if norm_squared <= f64::EPSILON {
                0.0
            } else {
                (
                    (
                        (sample_x - f64::from(from.0)) * horizontal + (sample_y - f64::from(from.1)) * vertical
                    ) / norm_squared
                ).clamp(0.0, 1.0)
            };
            let projected_x = f64::from(from.0) + position * horizontal;
            let projected_y = f64::from(from.1) + position * vertical;
            let separation = ( (sample_x - projected_x).powi(2) + (sample_y - projected_y).powi(2)).sqrt();
            let opacity = (half_weight + 0.5 - separation).clamp(0.0, 1.0);
            if opacity > 0.0 {
                blend_bgra_pixel(image, column, row, pigment, opacity);
            }
        }
    }
}

fn blend_bgra_pixel( image: &mut CpuBgraFrame, column: i32, row: i32, pigment: [u8; 4], opacity: f64) {
    if column < 0 || row < 0 || column >= image.width as i32 || row >= image.height as i32 {
        return;
    }
    let index = usize::try_from(row).unwrap_or_default() * image.pitch as usize + usize::try_from(column).unwrap_or_default() * 4;
    if let Some(destination) = image.pixels.get_mut(index..index + 4) {
        let effective_alpha = (f64::from(pigment[3]) / 255.0) * opacity;
        let retained = 1.0 - effective_alpha;
        for component in 0..3 {
            destination[component] = (
                f64::from(pigment[component]) * effective_alpha + f64::from(destination[component]) * retained
            ).round() as u8;
        }
        destination[3] = 0xff;
    }
}

fn annotation_bgra(hue: AnnotationColor) -> [u8; 4] {
    let (b8, g8, r8) = match hue {
        AnnotationColor::Blue => (0xff, 0x8d, 0x4c),
        AnnotationColor::Green => (0x96, 0xea, 0x3e),
        AnnotationColor::Yellow => (0x3b, 0xd4, 0xff),
        AnnotationColor::Red => (0x4f, 0x4d, 0xff),
    };
    [b8, g8, r8, 0xff]
}

fn dim_regions(width: u32, height: u32, selection: Option<RectI>) -> Vec<RectI> {
    let clipped = selection.and_then(
        |area| {
            let min_x = i64::from(area.x).clamp(0, i64::from(width));
            let min_y = i64::from(area.y).clamp(0, i64::from(height));
            let max_x = (i64::from(area.x) + i64::from(area.width)).clamp(0, i64::from(width));
            let max_y = (i64::from(area.y) + i64::from(area.height)).clamp(0, i64::from(height));
            (max_x > min_x && max_y > min_y).then_some(
                RectI {
                    x: i32::try_from(min_x).ok()?,
                    y: i32::try_from(min_y).ok()?,
                    width: u32::try_from(max_x - min_x).ok()?,
                    height: u32::try_from(max_y - min_y).ok()?,
                }
            )
        }
    );
    let Some(hole) = clipped else {
        return vec![RectI {
                x: 0,
                y: 0,
                width,
                height
        }];
    };
    let far_x = hole.x.saturating_add_unsigned(hole.width);
    let far_y = hole.y.saturating_add_unsigned(hole.height);
    let strips = [
        RectI {
            x: 0,
            y: 0,
            width,
            height: u32::try_from(hole.y).unwrap_or_default()
        },
        RectI {
            x: 0,
            y: far_y,
            width,
            height: height.saturating_sub(u32::try_from(far_y).unwrap_or(height))
        },
        RectI {
            x: 0,
            y: hole.y,
            width: u32::try_from(hole.x).unwrap_or_default(),
            height: hole.height
        },
        RectI {
            x: far_x,
            y: hole.y,
            width: width.saturating_sub(u32::try_from(far_x).unwrap_or(width)),
            height: hole.height
        },
    ];
    strips.into_iter().filter(|area| area.width > 0 && area.height > 0).collect()
}

pub fn compute_toolbar(selection: RectI, display: &DisplayInfo) -> Option<ToolbarLayout> {
    let viewport = RectI {
        x: 0,
        y: 0,
        width: display.bounds.width,
        height: display.bounds.height
    };
    let panel = place_toolbar(selection, viewport, TOOLBAR_WIDTH, TOOLBAR_HEIGHT, TOOLBAR_GAP)?;
    let button_span = 40;
    if panel.width < button_span * 5 + TOOLBAR_BUTTON_GAP * 4 {
        return None;
    }
    let slot = |ordinal: u32| RectI {
        x: panel.x.saturating_add_unsigned(ordinal * (button_span + TOOLBAR_BUTTON_GAP)),
        y: panel.y,
        width: button_span,
        height: panel.height,
    };
    let box_button = slot(0);
    let arrow_button = slot(1);
    let undo_button = slot(2);
    let cancel_button = slot(3);
    let confirm_button = slot(4);
    let swatch_span = 28;
    let swatch_gap = 6;
    let palette_span = swatch_span * 4 + swatch_gap * 3;
    let palette_x = panel.x + i32::try_from(panel.width.saturating_sub(palette_span) / 2).unwrap_or_default();
    let palette_y = if panel.y >= i32::try_from(swatch_span + swatch_gap).unwrap_or_default() {
        panel.y - i32::try_from(swatch_span + swatch_gap).unwrap_or_default()
    } else {
        panel.y.saturating_add_unsigned(panel.height + swatch_gap)
    };
    let swatches = std::array::from_fn(
        |ordinal| RectI {
            x: palette_x.saturating_add_unsigned( u32::try_from(ordinal).unwrap_or_default() * (swatch_span + swatch_gap)),
            y: palette_y,
            width: swatch_span,
            height: swatch_span,
        }
    );
    Some(
        ToolbarLayout {
            toolbar: panel,
            rectangle: box_button,
            arrow: arrow_button,
            undo: undo_button,
            confirm: confirm_button,
            cancel: cancel_button,
            colors: swatches
        }
    )
}

pub fn present_first_frame(overlay: &OverlayWindow) -> Result<(), HelperError> {
    let window_handle = overlay.hwnd();
    // UpdateWindow calls back into painting; no exclusive renderer borrow may span it.
    unsafe {
        _ = windows::Win32::Graphics::Gdi::InvalidateRect(Some(window_handle), None, false);
        _ = UpdateWindow(window_handle);
    }
    if let Some(failure) = overlay.take_paint_error() {
        return Err(failure);
    }
    unsafe {
        DwmFlush()
    }.map_err(HelperError::from)?;
    Ok(())
}

pub fn qpc_now() -> i64 {
    let mut sample = 0i64;
    let read = unsafe {
        windows::Win32::System::Performance::QueryPerformanceCounter(&mut sample)
    };
    match read {
        Ok(()) => sample,
        Err(_) => 0
    }
}

pub fn qpc_elapsed_ms(start: i64, end: i64) -> u64 {
    if start <= 0 || end <= start {
        return 0;
    }
    let mut ticks_per_second = 0i64;
    let read = unsafe {
        windows::Win32::System::Performance::QueryPerformanceFrequency(&mut ticks_per_second)
    };
    if read.is_err() || ticks_per_second <= 0 {
        return 0;
    }
    let elapsed = (end as u128).saturating_sub(start as u128);
    (elapsed.saturating_mul(1000) / ticks_per_second as u128) as u64
}
// These owners release in reverse declaration order. A selected bitmap needs
// its SelectionGuard declared last so it is unselected before deletion.
struct ScreenDcGuard(HDC);

impl ScreenDcGuard {
    fn acquire() -> Result<Self, HelperError> {
        let acquired = unsafe {
            GetDC(None)
        };
        if acquired.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(Self(acquired))
    }

    fn hdc(&self) -> HDC {
        self.0
    }
}

impl Drop for ScreenDcGuard {
    fn drop(&mut self) {
        unsafe {
            _ = ReleaseDC(None, self.0);
        }
    }
}

struct MemoryDcGuard(HDC);

impl MemoryDcGuard {
    fn create(reference: HDC) -> Result<Self, HelperError> {
        let acquired = unsafe {
            CreateCompatibleDC(Some(reference))
        };
        if acquired.is_invalid() {
            return Err(windows::core::Error::from_thread().into());
        }
        Ok(Self(acquired))
    }

    fn hdc(&self) -> HDC {
        self.0
    }

    fn into_handle(self) -> HDC {
        let transferred = self.0;
        std::mem::forget(self);
        transferred
    }
}

impl Drop for MemoryDcGuard {
    fn drop(&mut self) {
        unsafe {
            _ = DeleteDC(self.0);
        }
    }
}

struct BitmapGuard {
    bitmap: HBITMAP,
    storage: *mut core::ffi::c_void,
}

impl BitmapGuard {
    fn create_dib_top_down(destination: HDC, columns: i32, rows: i32) -> Result<Self, HelperError> {
        let description = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: columns,
                biHeight: -rows,
                biBitCount: 32,
                biPlanes: 1,
                biCompression: BI_RGB.0,
                biXPelsPerMeter: 0,
                biClrUsed: 0,
                biYPelsPerMeter: 0,
                biClrImportant: 0,
                biSizeImage: 0,
            },
            bmiColors: [Default::default()],
        };
        let mut storage = std::ptr::null_mut();
        let allocated = unsafe {
            CreateDIBSection( Some(destination), &description, DIB_RGB_COLORS, &mut storage, None, 0)
        };
        let bitmap = match allocated {
            Ok(handle) if !storage.is_null() => handle,
            Ok(handle) => {
                unsafe {
                    _ = DeleteObject(HGDIOBJ(handle.0));
                }
                return Err(
                    HelperError::CaptureFailed("CreateDIBSection returned a null bits pointer".into())
                );
            }
            Err(failure) => return Err(failure.into()),
        };
        Ok(Self {
                bitmap,
                storage
        })
    }

    fn bits(&self) -> *mut core::ffi::c_void {
        self.storage
    }

    fn into_bitmap(self) -> HBITMAP {
        let transferred = self.bitmap;
        std::mem::forget(self);
        transferred
    }
}

impl Drop for BitmapGuard {
    fn drop(&mut self) {
        unsafe {
            _ = DeleteObject(HGDIOBJ(self.bitmap.0));
        }
    }
}

struct SelectionGuard {
    destination: HDC,
    saved: HGDIOBJ,
    keep_selected: bool,
}

impl SelectionGuard {
    fn new(destination: HDC, saved: HGDIOBJ) -> Self {
        Self {
            destination,
            saved,
            keep_selected: false
        }
    }

    fn disarm(mut self) {
        self.keep_selected = true;
    }
}

impl Drop for SelectionGuard {
    fn drop(&mut self) {
        if !self.keep_selected {
            unsafe {
                _ = SelectObject(self.destination, self.saved);
            }
        }
    }
}

fn create_gdi_frame_cache(image: &CpuBgraFrame) -> Result<GdiFrameCache, HelperError> {
    let columns = i32::try_from(image.width).map_err(|_| HelperError::InvalidDisplay("frame width does not fit i32".into()))?;
    let rows = i32::try_from(image.height).map_err(|_| HelperError::InvalidDisplay("frame height does not fit i32".into()))?;
    let desktop = ScreenDcGuard::acquire()?;
    let source_dc = MemoryDcGuard::create(desktop.hdc())?;
    let source_bitmap = BitmapGuard::create_dib_top_down(source_dc.hdc(), columns, rows)?;
    let packed_stride = (image.width * 4) as usize;
    let input_stride = image.pitch as usize;
    let destination_bytes = source_bitmap.bits();
    unsafe {
        for row in 0..image.height as usize {
            let input = image.pixels.as_ptr().add(row * input_stride);
            let output = (destination_bytes as *mut u8).add(row * packed_stride);
            std::ptr::copy_nonoverlapping(input, output, packed_stride.min(input_stride));
        }
    }
    let source_saved = unsafe {
        SelectObject(source_dc.hdc(), HGDIOBJ(source_bitmap.bitmap.0))
    };
    if source_saved.0.is_null() || source_saved.0 as isize == -1 {
        return Err(windows::core::Error::from_thread().into());
    }
    let source_selection = SelectionGuard::new(source_dc.hdc(), source_saved);
    source_selection.disarm();
    let staging_dc = MemoryDcGuard::create(desktop.hdc())?;
    let staging_bitmap = BitmapGuard::create_dib_top_down(staging_dc.hdc(), columns, rows)?;
    let staging_saved = unsafe {
        SelectObject(staging_dc.hdc(), HGDIOBJ(staging_bitmap.bitmap.0))
    };
    if staging_saved.0.is_null() || staging_saved.0 as isize == -1 {
        return Err(windows::core::Error::from_thread().into());
    }
    let staging_selection = SelectionGuard::new(staging_dc.hdc(), staging_saved);
    staging_selection.disarm();
    let retained_source_dc = source_dc.into_handle();
    let retained_source_bitmap = source_bitmap.into_bitmap();
    let retained_staging_dc = staging_dc.into_handle();
    let retained_staging_bitmap = staging_bitmap.into_bitmap();
    drop(desktop);
    Ok(
        GdiFrameCache {
            columns: columns,
            rows: rows,
            source_bitmap: retained_source_bitmap,
            mem_dc: retained_source_dc,
            source_saved: source_saved,
            staging_bitmap: retained_staging_bitmap,
            staging_dc: retained_staging_dc,
            staging_saved: staging_saved,
        }
    )
}

fn paint_gdi_on_hdc(
    destination: HDC,
    backing: Option<&GdiFrameCache>,
    chosen: Option<RectI>,
    monitor: &DisplayInfo,
    _panel: Option<ToolbarLayout>
) -> Result<(), HelperError> {
    let columns = i32::try_from(monitor.bounds.width).map_err(|_| HelperError::InvalidDisplay("paint width does not fit i32".into()))?;
    let rows = i32::try_from(monitor.bounds.height).map_err(|_| HelperError::InvalidDisplay("paint height does not fit i32".into()))?;
    let viewport = RECT {
        left: 0,
        top: 0,
        right: columns,
        bottom: rows
    };
    match backing {
        Some(source) => {
            unsafe {
                _ = BitBlt(
                    destination,
                    0,
                    0,
                    source.columns,
                    source.rows,
                    Some(source.mem_dc),
                    0,
                    0,
                    SRCCOPY
                );
            }
            alpha_dim(destination, columns, rows, chosen)?;
            if let Some(hole) = chosen {
                unsafe {
                    _ = BitBlt(
                        destination,
                        hole.x,
                        hole.y,
                        i32::try_from(hole.width).unwrap_or(0),
                        i32::try_from(hole.height).unwrap_or(0),
                        Some(source.mem_dc),
                        hole.x,
                        hole.y,
                        SRCCOPY
                    );
                }
                draw_selection_border(destination, hole)?;
            }
        }
        None => {
            let empty_fill = unsafe {
                CreateSolidBrush(COLORREF(0x00303030))
            };
            if empty_fill.is_invalid() {
                return Err(windows::core::Error::from_thread().into());
            }
            unsafe {
                FillRect(destination, &viewport, empty_fill);
                _ = DeleteObject(HGDIOBJ(empty_fill.0));
            }
            if let Some(hole) = chosen {
                draw_selection_border(destination, hole)?;
            }
        }
    }
    Ok(())
}

fn alpha_dim(destination: HDC, columns: i32, rows: i32, chosen: Option<RectI>) -> Result<(), HelperError> {
    let desktop = ScreenDcGuard::acquire()?;
    let shade_dc = MemoryDcGuard::create(desktop.hdc())?;
    let shade_bitmap = BitmapGuard::create_dib_top_down(shade_dc.hdc(), 1, 1)?;
    unsafe {
        std::ptr::copy_nonoverlapping([0u8, 0, 0, 115].as_ptr(), shade_bitmap.bits() as *mut u8, 4);
    }
    let saved = unsafe {
        SelectObject(shade_dc.hdc(), HGDIOBJ(shade_bitmap.bitmap.0))
    };
    if saved.0.is_null() || saved.0 as isize == -1 {
        return Err(windows::core::Error::from_thread().into());
    }
    let _restore = SelectionGuard::new(shade_dc.hdc(), saved);
    let operation = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: 0xff,
        AlphaFormat: AC_SRC_ALPHA as u8
    };
    for outside in dim_regions(
        u32::try_from(columns).unwrap_or_default(),
        u32::try_from(rows).unwrap_or_default(),
        chosen
    ) {
        let span_x = i32::try_from(outside.width).unwrap_or_default();
        let span_y = i32::try_from(outside.height).unwrap_or_default();
        if span_x <= 0 || span_y <= 0 {
            continue;
        }
        unsafe {
            _ = AlphaBlend(
                destination,
                outside.x,
                outside.y,
                span_x,
                span_y,
                shade_dc.hdc(),
                0,
                0,
                1,
                1,
                operation
            );
        }
    }
    Ok(())
}
// The closure issues drawing calls only; restoration follows those calls even
// when GDI reports a drawing failure, just as for the other best-effort paints.
fn with_gdi_outline(destination: HDC, weight: i32, rgb: COLORREF, draw: impl FnOnce()) -> Result<(), HelperError> {
    let stroke: HPEN = unsafe {
        CreatePen(PS_SOLID, weight, rgb)
    };
    if stroke.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let saved_pen = unsafe {
        SelectObject(destination, HGDIOBJ(stroke.0))
    };
    let hollow = unsafe {
        GetStockObject(NULL_BRUSH)
    };
    let saved_fill = unsafe {
        SelectObject(destination, hollow)
    };
    draw();
    unsafe {
        _ = SelectObject(destination, saved_fill);
        _ = SelectObject(destination, saved_pen);
        _ = DeleteObject(HGDIOBJ(stroke.0));
    }
    Ok(())
}

fn draw_selection_border(destination: HDC, area: RectI) -> Result<(), HelperError> {
    with_gdi_outline(
        destination,
        2,
        COLORREF(0x0096ea3e),
        || unsafe {
            _ = Rectangle(
                destination,
                area.x,
                area.y,
                area.x.saturating_add_unsigned(area.width),
                area.y.saturating_add_unsigned(area.height)
            );
        }
    )
}

fn draw_overlay_details_gdi(
    destination: HDC,
    chosen: Option<RectI>,
    panel: Option<ToolbarLayout>,
    annotations: &[Mark],
    preview: Option<Mark>,
    palette_open: bool,
    tool: Option<AnnotationTool>,
    hue: AnnotationColor
) -> Result<(), HelperError> {
    for annotation in annotations.iter().copied().chain(preview) {
        draw_mark_gdi(destination, annotation)?;
    }
    if let Some(area) = chosen {
        draw_selection_handles_and_size(destination, area)?;
    }
    if let Some(buttons) = panel {
        draw_toolbar_icons_gdi(destination, buttons, tool)?;
        if palette_open {
            draw_color_choices_gdi(destination, buttons.colors, hue)?;
        }
    }
    Ok(())
}

fn draw_mark_gdi(destination: HDC, annotation: Mark) -> Result<(), HelperError> {
    let (from, to, hue, pointed) = (annotation.start, annotation.end, annotation.color, annotation.is_arrow());
    with_gdi_outline(
        destination,
        3,
        annotation_colorref(hue),
        || unsafe {
            if pointed {
                _ = MoveToEx(destination, from.x, from.y, None);
                _ = LineTo(destination, to.x, to.y);
                let (unit_x, unit_y) = arrow_unit((from.x, from.y), (to.x, to.y));
                for direction in [-1.0, 1.0] {
                    let tail_x = f64::from(to.x) - unit_x * 12.0 + (-unit_y) * 6.0 * direction;
                    let tail_y = f64::from(to.y) - unit_y * 12.0 + unit_x * 6.0 * direction;
                    _ = MoveToEx(destination, to.x, to.y, None);
                    _ = LineTo(destination, tail_x.round() as i32, tail_y.round() as i32);
                }
            } else {
                let min_x = from.x.min(to.x);
                let min_y = from.y.min(to.y);
                let max_x = from.x.max(to.x);
                let max_y = from.y.max(to.y);
                _ = Rectangle(destination, min_x, min_y, max_x, max_y);
            }
        }
    )
}

fn draw_selection_handles_and_size(destination: HDC, area: RectI) -> Result<(), HelperError> {
    let accent = unsafe {
        CreateSolidBrush(COLORREF(0x0096ea3e))
    };
    if accent.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    for (horizontal, vertical) in selection_handle_centers(area) {
        let square = RECT {
            left: horizontal - 4,
            top: vertical - 4,
            right: horizontal + 5,
            bottom: vertical + 5
        };
        unsafe {
            FillRect(destination, &square, accent);
        }
    }
    unsafe {
        _ = DeleteObject(HGDIOBJ(accent.0));
        _ = SetBkMode(destination, TRANSPARENT);
        _ = SetTextColor(destination, COLORREF(0x00ffffff));
    }
    let caption = format!("{} x {}", area.width, area.height);
    let utf16: Vec<u16> = caption.encode_utf16().collect();
    let baseline = if area.y >= 22 {
        area.y - 22
    } else {
        area.y + 6
    };
    unsafe {
        _ = TextOutW(destination, area.x, baseline, &utf16);
    }
    Ok(())
}

fn draw_toolbar_icons_gdi(destination: HDC, panel: ToolbarLayout, tool: Option<AnnotationTool>) -> Result<(), HelperError> {
    if tool == Some(AnnotationTool::Rectangle) {
        fill_gdi_rect(destination, panel.rectangle, 0x00505055);
    } else if tool == Some(AnnotationTool::Arrow) {
        fill_gdi_rect(destination, panel.arrow, 0x00505055);
    }
    let foreground = COLORREF(0x00ffffff);
    with_gdi_outline(
        destination,
        3,
        foreground,
        || unsafe {
            let box_area = inset(panel.rectangle, 11);
            _ = Rectangle(
                destination,
                box_area.x,
                box_area.y,
                box_area.x.saturating_add_unsigned(box_area.width),
                box_area.y.saturating_add_unsigned(box_area.height)
            );
            let arrow_area = panel.arrow;
            _ = MoveToEx(destination, arrow_area.x + 10, arrow_area.y + 29, None);
            _ = LineTo(destination, arrow_area.x + 29, arrow_area.y + 10);
            _ = MoveToEx(destination, arrow_area.x + 20, arrow_area.y + 10, None);
            _ = LineTo(destination, arrow_area.x + 29, arrow_area.y + 10);
            _ = LineTo(destination, arrow_area.x + 29, arrow_area.y + 19);
            let undo_area = panel.undo;
            _ = MoveToEx(destination, undo_area.x + 28, undo_area.y + 12, None);
            _ = LineTo(destination, undo_area.x + 14, undo_area.y + 12);
            _ = LineTo(destination, undo_area.x + 9, undo_area.y + 18);
            _ = MoveToEx(destination, undo_area.x + 14, undo_area.y + 12, None);
            _ = LineTo(destination, undo_area.x + 14, undo_area.y + 23);
            _ = LineTo(destination, undo_area.x + 27, undo_area.y + 27);
        }
    )?;
    draw_x_or_check(destination, panel.cancel, false)?;
    draw_x_or_check(destination, panel.confirm, true)
}

fn draw_x_or_check(destination: HDC, area: RectI, accepted: bool) -> Result<(), HelperError> {
    let rgb = if accepted {
        0x0096ea3e
    } else {
        0x005f5aff
    };
    let stroke = unsafe {
        CreatePen(PS_SOLID, 4, COLORREF(rgb))
    };
    if stroke.is_invalid() {
        return Err(windows::core::Error::from_thread().into());
    }
    let saved = unsafe {
        SelectObject(destination, HGDIOBJ(stroke.0))
    };
    unsafe {
        if accepted {
            _ = MoveToEx(destination, area.x + 9, area.y + 21, None);
            _ = LineTo(destination, area.x + 17, area.y + 29);
            _ = LineTo(destination, area.x + 31, area.y + 11);
        } else {
            _ = MoveToEx(destination, area.x + 10, area.y + 10, None);
            _ = LineTo(destination, area.x + 30, area.y + 30);
            _ = MoveToEx(destination, area.x + 30, area.y + 10, None);
            _ = LineTo(destination, area.x + 10, area.y + 30);
        }
        _ = SelectObject(destination, saved);
        _ = DeleteObject(HGDIOBJ(stroke.0));
    }
    Ok(())
}

fn draw_color_choices_gdi(destination: HDC, swatches: [RectI; 4], selected_hue: AnnotationColor) -> Result<(), HelperError> {
    let palette = [
        AnnotationColor::Red,
        AnnotationColor::Yellow,
        AnnotationColor::Green,
        AnnotationColor::Blue
    ];
    for (area, hue) in swatches.into_iter().zip(palette) {
        fill_gdi_rect(destination, area, annotation_colorref(hue).0);
        if hue == selected_hue {
            with_gdi_outline(
                destination,
                2,
                COLORREF(0x00ffffff),
                || unsafe {
                    _ = Rectangle(
                        destination,
                        area.x - 2,
                        area.y - 2,
                        area.x.saturating_add_unsigned(area.width) + 2,
                        area.y.saturating_add_unsigned(area.height) + 2
                    );
                }
            )?;
        }
    }
    Ok(())
}

fn annotation_colorref(hue: AnnotationColor) -> COLORREF {
    let rgb = match hue {
        AnnotationColor::Blue => 0x00ff8d4c,
        AnnotationColor::Green => 0x0096ea3e,
        AnnotationColor::Yellow => 0x003bd4ff,
        AnnotationColor::Red => 0x004f4dff,
    };
    COLORREF(rgb)
}

fn fill_gdi_rect(destination: HDC, area: RectI, rgb: u32) {
    let pigment = unsafe {
        CreateSolidBrush(COLORREF(rgb))
    };
    if pigment.is_invalid() {
        return;
    }
    let fill_area = RECT {
        left: area.x,
        top: area.y,
        right: area.x.saturating_add_unsigned(area.width),
        bottom: area.y.saturating_add_unsigned(area.height)
    };
    unsafe {
        FillRect(destination, &fill_area, pigment);
        _ = DeleteObject(HGDIOBJ(pigment.0));
    }
}

fn inset(area: RectI, margin: u32) -> RectI {
    RectI {
        x: area.x.saturating_add_unsigned(margin),
        y: area.y.saturating_add_unsigned(margin),
        width: area.width.saturating_sub(margin * 2),
        height: area.height.saturating_sub(margin * 2)
    }
}

fn draw_toolbar_gdi(destination: HDC, panel: ToolbarLayout) -> Result<(), HelperError> {
    fill_gdi_rect(destination, panel.toolbar, 0x00202024);
    Ok(())
}

pub(crate) fn paint_hdc(destination: HDC, chosen: Option<RectI>, monitor: &DisplayInfo) -> Result<(), HelperError> {
    paint_gdi_on_hdc(destination, None, chosen, monitor, None)
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{DisplayRotation, PointI};

    /// A frame whose pixel (x, y) is BGRA [3x, 5y, 100 + x + y, 255], so any copied pixel names its source.
    fn labelled_frame(width: u32, height: u32) -> CpuBgraFrame {
        let pixels = (0..height)
            .flat_map(|y| (0..width).flat_map(move |x| [(3 * x) as u8, (5 * y) as u8, (100 + x + y) as u8, 255]))
            .collect();
        CpuBgraFrame { width, height, pitch: width * 4, pixels }
    }

    fn blank_frame(side: u32) -> CpuBgraFrame {
        CpuBgraFrame { width: side, height: side, pitch: side * 4, pixels: vec![0; (side * side * 4) as usize] }
    }

    fn pixel(frame: &CpuBgraFrame, x: u32, y: u32) -> [u8; 4] {
        let at = (y * frame.pitch + x * 4) as usize;
        frame.pixels[at..at + 4].try_into().expect("four channels")
    }

    #[test]
    fn every_upload_is_counted_and_clearing_keeps_the_count() {
        let mut renderer = OverlayRenderer::new().expect("the renderer starts");
        let frame = blank_frame(6);
        for expected in 1..=3 {
            renderer.upload_frozen(&frame).expect("a frame uploads");
            assert_eq!(renderer.upload_count, expected);
        }
        renderer.clear_frozen();
        assert!(renderer.gdi_cache.is_none(), "clearing drops the CPU copy");
        assert_eq!(renderer.upload_count, 3, "the diagnostic count survives clearing");
    }

    #[test]
    fn the_cpu_cache_composes_off_screen_and_releases_cleanly() {
        let cache = create_gdi_frame_cache(&blank_frame(10)).expect("a cache is created");
        // Composing straight into the frozen source would show half-drawn frames.
        assert_ne!(cache.mem_dc, cache.composition_hdc());
        drop(cache);
    }

    #[test]
    fn a_selection_is_cut_from_exactly_the_requested_rectangle() {
        let mut renderer = OverlayRenderer::new().expect("the renderer starts");
        renderer.upload_frozen(&labelled_frame(5, 4)).expect("the frame uploads");
        let cut = renderer.extract_selection(RectI { x: 2, y: 1, width: 2, height: 3 }, None).expect("the selection is extracted");
        let expected: Vec<u8> = (1..=3u32).flat_map(|y| (2..=3u32).flat_map(move |x| [(3 * x) as u8, (5 * y) as u8, (100 + x + y) as u8, 255])).collect();
        assert_eq!(cut.pixels, expected);
    }

    #[test]
    fn toolbar_buttons_run_left_to_right_with_four_colour_swatches() {
        let display = DisplayInfo {
            bounds: RectI { x: 0, y: 0, width: 1280, height: 720 },
            dpi: 144.0,
            rotation: DisplayRotation::Identity,
            is_primary: true,
        };
        let bar = compute_toolbar(RectI { x: 300, y: 200, width: 500, height: 260 }, &display).expect("a toolbar fits");
        let order = [bar.rectangle.x, bar.arrow.x, bar.undo.x, bar.cancel.x, bar.confirm.x];
        assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "buttons out of order: {order:?}");
        assert_eq!(bar.colors.len(), 4);
    }

    #[test]
    fn a_burned_mark_lands_relative_to_the_selection_origin() {
        let mut frame = blank_frame(16);
        let mark = Mark { tool: AnnotationTool::Rectangle, start: PointI { x: 25, y: 31 }, end: PointI { x: 33, y: 40 }, color: AnnotationColor::Red };
        burn_annotations(&mut frame, &[mark], PointI { x: 20, y: 30 });
        // Red is #FF4D4F, stored as BGRA.
        assert_eq!(pixel(&frame, 5, 1), [0x4f, 0x4d, 0xff, 0xff]);
        assert_eq!(pixel(&frame, 0, 0), [0, 0, 0, 0], "pixels away from the mark are untouched");
    }

    #[test]
    fn a_slanted_arrow_has_partly_covered_edge_pixels() {
        let mut frame = blank_frame(30);
        let arrow = Mark { tool: AnnotationTool::Arrow, start: PointI { x: 3, y: 25 }, end: PointI { x: 26, y: 4 }, color: AnnotationColor::Red };
        burn_annotations(&mut frame, &[arrow], PointI { x: 0, y: 0 });
        assert!(frame.pixels.chunks_exact(4).any(|bgra| bgra[2] > 0 && bgra[2] < 0xff), "no anti-aliased edge");
    }

    #[test]
    fn dimming_covers_the_four_bands_around_the_selection() {
        let bands = dim_regions(200, 100, Some(RectI { x: 50, y: 20, width: 60, height: 30 }));
        let total: u64 = bands.iter().map(|band| u64::from(band.width) * u64::from(band.height)).sum();
        assert_eq!(total, 200 * 100 - 60 * 30, "the bands cover everything but the selection, once");
        for band in [
            RectI { x: 0, y: 0, width: 200, height: 20 },
            RectI { x: 0, y: 50, width: 200, height: 50 },
            RectI { x: 0, y: 20, width: 50, height: 30 },
            RectI { x: 110, y: 20, width: 90, height: 30 },
        ] {
            assert!(bands.contains(&band), "missing {band:?} in {bands:?}");
        }
    }
}
