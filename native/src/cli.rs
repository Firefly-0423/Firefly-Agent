use crate::{error::AppError, protocol::PROTOCOL_VERSION};
use std::path::PathBuf;

/// 启动参数解析后的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliOptions {
    /// 输出目录（必须是绝对路径）
    pub output_dir: PathBuf,
    /// 宿主声明的协议版本
    pub protocol_version: u32,
    /// 宿主进程 id，用于监测宿主是否退出
    pub parent_pid: u32,
}

fn bad_args(text: impl Into<String>) -> AppError {
    AppError::InvalidArguments(text.into())
}

/// 把值写入槽位；槽位已有值说明参数重复出现。
fn fill_once<T>(slot: &mut Option<T>, value: T, flag: &str) -> Result<(), AppError> {
    match slot.replace(value) {
        None => Ok(()),
        Some(_) => Err(bad_args(format!("{flag} was provided more than once"))),
    }
}

fn parse_u32(raw: String, flag: &str) -> Result<u32, AppError> {
    raw.parse::<u32>()
        .map_err(|_| bad_args(format!("{flag} must be a u32")))
}

pub fn parse_arguments<I, S>(arguments: I) -> Result<CliOptions, AppError>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut tokens = arguments.into_iter().map(Into::into);
    let mut dir_slot: Option<PathBuf> = None;
    let mut version_slot: Option<u32> = None;
    let mut pid_slot: Option<u32> = None;

    while let Some(flag) = tokens.next() {
        // 三个选项都要求紧跟一个取值
        let mut operand = |name: &str| {
            tokens
                .next()
                .ok_or_else(|| bad_args(format!("missing value for {name}")))
        };
        match flag.as_str() {
            "--output-dir" => {
                let raw = operand(&flag)?;
                fill_once(&mut dir_slot, PathBuf::from(raw), "--output-dir")?;
            }
            "--protocol-version" => {
                let parsed = parse_u32(operand(&flag)?, "--protocol-version")?;
                fill_once(&mut version_slot, parsed, "--protocol-version")?;
            }
            "--parent-pid" => {
                let parsed = parse_u32(operand(&flag)?, "--parent-pid")?;
                fill_once(&mut pid_slot, parsed, "--parent-pid")?;
            }
            other => return Err(bad_args(format!("unknown argument {other}"))),
        }
    }

    let Some(output_dir) = dir_slot else {
        return Err(bad_args("--output-dir is required"));
    };
    if !output_dir.is_absolute() {
        return Err(bad_args("--output-dir must be an absolute path"));
    }

    let Some(protocol_version) = version_slot else {
        return Err(bad_args("--protocol-version is required"));
    };
    if protocol_version != PROTOCOL_VERSION {
        return Err(AppError::ProtocolVersionMismatch {
            expected: PROTOCOL_VERSION,
            provided: protocol_version,
        });
    }

    let Some(parent_pid) = pid_slot else {
        return Err(bad_args("--parent-pid is required"));
    };

    Ok(CliOptions {
        output_dir,
        protocol_version,
        parent_pid,
    })
}

pub fn run() -> Result<(), AppError> {
    let options = parse_arguments(std::env::args().skip(1))?;
    crate::app::run(options)
}
