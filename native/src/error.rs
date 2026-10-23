/// 进程级错误：启动参数、协议版本、系统调用与运行时失败。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    /// 运行期的通用失败，携带说明文字。
    #[error("runtime failed: {0}")]
    Runtime(String),

    /// 文件或管道读写失败。
    #[error("I/O failed: {0}")]
    Io(#[from] std::io::Error),

    /// 底层 Win32/COM 调用返回错误。
    #[error("Windows API failed: {0}")]
    Windows(#[from] windows::core::Error),

    /// 命令行参数缺失、重复或格式不对。
    #[error("invalid arguments: {0}")]
    InvalidArguments(String),

    /// 宿主与 helper 的协议版本不一致。
    #[error("unsupported protocol version {provided}; expected {expected}")]
    ProtocolVersionMismatch { provided: u32, expected: u32 },

    /// 图形抓屏初始化尚未实现。
    #[error("not-implemented: graphical capture initialization")]
    NotImplemented,
}

impl AppError {
    /// 稳定的机器可读错误码。
    pub fn code(&self) -> &'static str {
        use AppError::*;
        match self {
            Runtime(_) => "runtime-failed",
            Io(_) => "io-failed",
            Windows(_) => "windows-api-failed",
            InvalidArguments(_) => "invalid-arguments",
            ProtocolVersionMismatch { .. } => "protocol-version-mismatch",
            NotImplemented => "not-implemented",
        }
    }
}

// 请求内错误折叠成进程级的 Runtime，这样不必给已锁定的协议面再加变体，
// 原始错误码仍可通过 HelperError::code() 单独取得。
impl From<HelperError> for AppError {
    fn from(source: HelperError) -> Self {
        AppError::Runtime(source.to_string())
    }
}

/// NDJSON 命令行解析阶段的错误。
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    /// JSON 解析失败，或字段不符合命令定义。
    #[error("invalid command: {0}")]
    InvalidCommand(#[from] serde_json::Error),

    /// 单行超过允许的字节数上限。
    #[error("NDJSON line exceeds 65536 bytes")]
    LineTooLong,
}

impl ProtocolError {
    pub fn code(&self) -> &'static str {
        use ProtocolError::*;
        match self {
            InvalidCommand(_) => "invalid-command",
            LineTooLong => "line-too-long",
        }
    }
}

/// 单次截图请求内部的失败：查询显示器、抓屏、几何换算、编码以及系统调用。
/// 与进程级的 `AppError`、协议层的 `ProtocolError` 分开建模。
#[derive(Debug, thiserror::Error)]
pub enum HelperError {
    /// 抓屏后端出错。
    #[error("capture failed: {0}")]
    CaptureFailed(String),

    /// 查询显示器信息失败。
    #[error("display query failed: {0}")]
    DisplayQueryFailed(String),

    /// 显示器配置不合法（例如尺寸为零或超限）。
    #[error("invalid display configuration: {0}")]
    InvalidDisplay(String),

    /// 图像编码失败。
    #[error("encode failed: {0}")]
    EncodeFailed(String),

    /// 底层 Win32/COM 调用返回错误。
    #[error("Windows API failed: {0}")]
    Windows(#[from] windows::core::Error),
}

impl HelperError {
    /// 稳定的机器可读错误码。
    pub fn code(&self) -> &'static str {
        use HelperError::*;
        match self {
            CaptureFailed(_) => "capture-failed",
            DisplayQueryFailed(_) => "display-query-failed",
            InvalidDisplay(_) => "invalid-display",
            EncodeFailed(_) => "encode-failed",
            Windows(_) => "windows-api-failed",
        }
    }
}
