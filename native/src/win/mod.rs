//! Windows 平台的抓屏与显示后端。
//!
//! 只有这一层直接调用 Win32 图形接口来冻结主显示器：
//!
//! * [`display`]：设置 DPI 感知并查询主显示器。
//! * [`capture`]：定义其余部分使用的 [`FrozenFrame`] / [`CaptureBackend`] 抽象。
//! * [`capture_dxgi`]：基于 DXGI Desktop Duplication 的实现，是正常桌面下的首选路径。
//! * [`capture_gdi`]：用 GDI BitBlt 写入 32 位自上而下 DIB 的实现，
//!   在 DXGI 初始化失败或光标被合成进桌面时作为后备。
//!
//! 覆盖窗口（含输入状态机）、Direct2D 绘制以及剪贴板和编码器接线在其余 `win` 子模块中。

#![cfg(windows)]

// 显示器信息与抓屏后端
pub mod capture;
pub mod capture_dxgi;
pub mod capture_gdi;
pub mod display;

// 覆盖窗口与绘制
pub mod renderer;
pub mod window;

// 结果输出：剪贴板与图像编码
pub mod clipboard;
pub mod encoder;
