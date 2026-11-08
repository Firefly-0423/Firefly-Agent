use crate::error::ProtocolError;
use crate::win::capture::CaptureDiagnostics;

/// Main 与 helper 约定的协议版本；启动参数里的版本不同就直接报错退出。
pub const PROTOCOL_VERSION: u32 = 1;
/// stdin 上一条命令（不含换行）的最大字节数：64 KiB。
pub const MAX_NDJSON_LINE_BYTES: usize = 64 * 1024;

/// Main 通过 stdin 发来的命令，每行一个 JSON 对象，用 `type` 区分；未知字段一律拒绝。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Command {
    /// 开始一次截图：`{"type":"start","requestId":…,"mode":…}`。
    #[serde(rename_all = "camelCase")]
    Start { request_id: String, mode: CaptureMode },
    /// 取消某个请求，不论它还在框选还是已在后台交付。
    #[serde(rename_all = "camelCase")]
    Cancel { request_id: String },
    /// 结束 helper 进程。
    Shutdown,
}

/// 截图确认后交付到哪里，协议上写作 `clipboard-only` / `clipboard-and-file`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureMode {
    ClipboardAndFile,
    ClipboardOnly,
}

/// helper 写到 stdout 的事件，每行一个 JSON 对象：`type` 为变体名的 kebab-case，字段名为 camelCase。
/// 一次截图依次报告 accepted → interaction-state(selecting) → overlay-visible → …selected → committing
/// → capture-released → completed；中途可能以 cancelled 或 error 结束。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
pub enum Event {
    Ready { protocol_version: u32 },
    Accepted { request_id: String },
    InteractionState { request_id: String, state: InteractionStateEvent },
    /// 遮罩已显示冻结画面；`freeze_duration_ms` 从受理到首帧呈现。
    OverlayVisible { request_id: String, freeze_duration_ms: u64, diagnostics: CaptureDiagnostics },
    /// 选区像素已取出、剪贴板已写（或失败），遮罩已收起；文件模式此后还要等后台编码。
    CaptureReleased { request_id: String, clipboard_written: bool, width: u32, height: u32, diagnostics: CaptureDiagnostics },
    /// 交付完成。`file_name` 只在存文件模式下有值；只报告是否画过标注，不回传标注内容。
    Completed { request_id: String, mime: &'static str, width: u32, height: u32, file_name: Option<String>, clipboard_written: bool, has_annotations: bool },
    Cancelled { request_id: String, reason: String },
    /// `code` 为稳定错误码；`recoverable` 为真时 helper 继续接受后续命令。与请求无关时省略 requestId。
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        code: String,
        message: String,
        recoverable: bool,
    },
}

/// `interaction-state` 事件里的遮罩阶段。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InteractionStateEvent {
    /// 遮罩已显示，等待拖出选区。
    Selecting,
    /// 有了选区，可以标注、确认或取消。
    Selected,
    /// 已确认，正在取出像素并写剪贴板。
    Committing,
}

/// 解析一行 NDJSON 命令；超长行直接拒绝。
pub fn parse_command_line(line: &str) -> Result<Command, ProtocolError> {
    if line.len() > MAX_NDJSON_LINE_BYTES {
        return Err(ProtocolError::LineTooLong);
    }
    let command = serde_json::from_str::<Command>(line)?;
    Ok(command)
}
