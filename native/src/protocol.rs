use crate::error::ProtocolError;
use crate::win::capture::CaptureDiagnostics;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_NDJSON_LINE_BYTES: usize = 65_536;

/// 截图完成后结果的去向。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureMode {
    /// 只写入剪贴板
    ClipboardOnly,
    /// 写入剪贴板并保存文件
    ClipboardAndFile,
}

/// 宿主发给 helper 的命令；字段名在协议上使用 camelCase。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields, tag = "type", rename_all = "kebab-case")]
pub enum Command {
    /// 让 helper 退出。
    Shutdown,

    /// 取消指定请求。
    #[serde(rename_all = "camelCase")]
    Cancel { request_id: String },

    /// 开始一次截图。
    #[serde(rename_all = "camelCase")]
    Start {
        request_id: String,
        mode: CaptureMode,
    },
}

/// 覆盖层的交互阶段，随 `interaction-state` 事件上报。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InteractionStateEvent {
    /// 正在拖选
    Selecting,
    /// 选区已定
    Selected,
    /// 正在提交
    Committing,
}

/// helper 回报给宿主的事件；字段名在协议上使用 camelCase，键的顺序与声明顺序一致。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Event {
    /// 启动完成，宣告所用的协议版本。
    #[serde(rename_all = "camelCase")]
    Ready { protocol_version: u32 },

    /// 请求已被接受。
    #[serde(rename_all = "camelCase")]
    Accepted { request_id: String },

    /// 冻结画面已显示。
    #[serde(rename_all = "camelCase")]
    OverlayVisible {
        request_id: String,
        freeze_duration_ms: u64,
        diagnostics: CaptureDiagnostics,
    },

    /// 交互阶段变化。
    #[serde(rename_all = "camelCase")]
    InteractionState {
        request_id: String,
        state: InteractionStateEvent,
    },

    /// 抓屏已释放（选区读回完毕，剪贴板写入结果已知）。
    #[serde(rename_all = "camelCase")]
    CaptureReleased {
        request_id: String,
        clipboard_written: bool,
        width: u32,
        height: u32,
        diagnostics: CaptureDiagnostics,
    },

    /// 请求完成。
    #[serde(rename_all = "camelCase")]
    Completed {
        request_id: String,
        file_name: Option<String>,
        width: u32,
        height: u32,
        // 输出图像的 MIME 类型
        mime: &'static str,
        clipboard_written: bool,
        has_annotations: bool,
    },

    /// 请求被取消。
    #[serde(rename_all = "camelCase")]
    Cancelled { request_id: String, reason: String },

    /// 出错；与具体请求无关时不带 requestId。
    #[serde(rename_all = "camelCase")]
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        request_id: Option<String>,
        // 稳定的错误码
        code: String,
        message: String,
        // 为真表示 helper 仍可继续服务后续请求
        recoverable: bool,
    },
}

/// 解析一行 NDJSON 命令；超长行直接拒绝。
pub fn parse_command_line(line: &str) -> Result<Command, ProtocolError> {
    if line.len() > MAX_NDJSON_LINE_BYTES {
        return Err(ProtocolError::LineTooLong);
    }
    let command = serde_json::from_str::<Command>(line)?;
    Ok(command)
}
