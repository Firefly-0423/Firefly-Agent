//! 截图请求台账：Main 发来的每个 requestId 从受理到结束只走一遍，结束后可以被新请求复用。

use std::collections::HashMap;

use crate::protocol::CaptureMode;

/// 台账拒绝一次操作的原因；`code()` 是协议上的错误码。
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
            Self::AlreadyPending(_) => "request-already-pending",
            Self::AlreadyFinished(_) => "request-already-finished",
            Self::NotFound(_) => "request-not-found",
        }
    }
}

/// 一个 requestId 当前的状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    /// 已受理，还没有发出 completed / cancelled。`released` 表示遮罩已收起、正在后台交付。
    Open { released: bool },
    /// 已经发出终止事件。
    Closed,
}

#[derive(Debug, Default)]
pub struct RequestRegistry {
    phases: HashMap<String, Phase>,
}

impl RequestRegistry {
    pub fn is_pending(&self, request_id: &str) -> bool {
        matches!(self.phases.get(request_id), Some(Phase::Open { .. }))
    }

    /// 受理新请求。仍在进行的 id 不能重复受理；已结束的 id 可以重新开始。
    /// 交付方式由调用方自己保管，台账只关心请求是否结束。
    pub fn accept(&mut self, request_id: &str, _mode: CaptureMode) -> Result<(), RequestError> {
        if self.is_pending(request_id) {
            return Err(RequestError::AlreadyPending(request_id.to_owned()));
        }
        self.phases.insert(request_id.to_owned(), Phase::Open { released: false });
        Ok(())
    }

    /// 遮罩已收起、剪贴板已处理；请求仍未结束，等交付完成后再 complete。
    /// 结果数据随 `capture-released` 事件直接发给 Main，这里只记录阶段。
    pub fn capture_released(&mut self, request_id: &str, _clipboard_written: bool, _width: u32, _height: u32) -> Result<(), RequestError> {
        let phase = self.open_phase(request_id)?;
        *phase = Phase::Open { released: true };
        Ok(())
    }

    pub fn complete(&mut self, request_id: &str, _file_name: Option<String>) -> Result<(), RequestError> {
        self.close(request_id)
    }

    pub fn cancel(&mut self, request_id: &str, _reason: &str) -> Result<(), RequestError> {
        self.close(request_id)
    }

    fn open_phase(&mut self, request_id: &str) -> Result<&mut Phase, RequestError> {
        match self.phases.get_mut(request_id) {
            Some(phase @ Phase::Open { .. }) => Ok(phase),
            Some(Phase::Closed) => Err(RequestError::AlreadyFinished(request_id.to_owned())),
            None => Err(RequestError::NotFound(request_id.to_owned())),
        }
    }

    fn close(&mut self, request_id: &str) -> Result<(), RequestError> {
        *self.open_phase(request_id)? = Phase::Closed;
        Ok(())
    }
}
