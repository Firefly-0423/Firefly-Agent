use std::collections::{HashMap, HashSet};

use crate::protocol::CaptureMode;

/// 请求在覆盖层交互中所处的阶段。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureInteractionState {
    /// 尚无进行中的交互
    Idle,
    /// 正在冻结屏幕
    Freezing,
    /// 用户正在拖选区域
    Selecting,
    /// 选区已确定
    Selected,
    /// 正在提交结果
    Committing,
    /// 正在取消
    Cancelling,
}

/// 请求登记表的错误。
#[derive(Debug, thiserror::Error)]
pub enum RequestError {
    #[error("request was not found: {0}")]
    NotFound(String),
    #[error("request is already finished: {0}")]
    AlreadyFinished(String),
    #[error("request is already pending: {0}")]
    AlreadyPending(String),
}

impl RequestError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "request-not-found",
            Self::AlreadyFinished(_) => "request-already-finished",
            Self::AlreadyPending(_) => "request-already-pending",
        }
    }
}

/// 抓屏释放时的结果快照，目前仅记录不读取。
#[derive(Debug)]
#[allow(dead_code)]
struct CaptureRelease {
    width: u32,
    height: u32,
    // 剪贴板是否写入成功
    clipboard_written: bool,
}

/// 进行中请求的记录。
#[derive(Debug)]
struct PendingRequest {
    capture_release: Option<CaptureRelease>,
    _mode: CaptureMode,
}

/// 记录哪些请求正在进行、哪些已经结束。
#[derive(Debug, Default)]
pub struct RequestRegistry {
    finished: HashSet<String>,
    pending: HashMap<String, PendingRequest>,
}

impl RequestRegistry {
    /// 查询请求是否仍在进行。
    pub fn is_pending(&self, request_id: &str) -> bool {
        self.pending.contains_key(request_id)
    }

    /// 登记新请求；同一 id 已在进行时拒绝。
    pub fn accept(&mut self, request_id: &str, mode: CaptureMode) -> Result<(), RequestError> {
        if self.is_pending(request_id) {
            return Err(RequestError::AlreadyPending(request_id.to_owned()));
        }
        // 已结束的 id 允许复用，先清掉旧的结束标记
        self.finished.remove(request_id);
        let entry = PendingRequest {
            capture_release: None,
            _mode: mode,
        };
        self.pending.insert(request_id.to_owned(), entry);
        Ok(())
    }

    /// 记录抓屏释放时的剪贴板结果与尺寸。
    pub fn capture_released(
        &mut self,
        request_id: &str,
        // 先给出剪贴板结果，再给出最终图像尺寸
        clipboard_written: bool,
        width: u32,
        height: u32,
    ) -> Result<(), RequestError> {
        let entry = self.lookup_pending(request_id)?;
        entry.capture_release = Some(CaptureRelease {
            width,
            height,
            clipboard_written,
        });
        Ok(())
    }

    /// 请求成功结束。
    pub fn complete(
        &mut self,
        request_id: &str,
        // 文件名目前不记录
        _file_name: Option<String>,
    ) -> Result<(), RequestError> {
        self.finish(request_id)
    }

    /// 请求被取消。
    pub fn cancel(&mut self, request_id: &str, _reason: &str) -> Result<(), RequestError> {
        self.finish(request_id)
    }

    /// 找不到进行中的请求时，按是否曾经结束区分两种错误。
    fn missing(&self, request_id: &str) -> RequestError {
        let id = request_id.to_owned();
        if self.finished.contains(request_id) {
            RequestError::AlreadyFinished(id)
        } else {
            RequestError::NotFound(id)
        }
    }

    fn lookup_pending(&mut self, request_id: &str) -> Result<&mut PendingRequest, RequestError> {
        if !self.pending.contains_key(request_id) {
            return Err(self.missing(request_id));
        }
        Ok(self
            .pending
            .get_mut(request_id)
            .expect("presence checked just above"))
    }

    fn finish(&mut self, request_id: &str) -> Result<(), RequestError> {
        if self.pending.remove(request_id).is_none() {
            return Err(self.missing(request_id));
        }
        self.finished.insert(request_id.to_owned());
        Ok(())
    }
}
