use firefly_screenshot::{cli, error::AppError, ipc, protocol::Event};

fn main() {
    let failure = match cli::run() {
        Ok(()) => return,
        Err(failure) => failure,
    };
    report_failure(&failure);
    std::process::exit(1);
}

fn report_failure(failure: &AppError) {
    match failure {
        AppError::ProtocolVersionMismatch { provided: supplied, expected: required } => {
            let notification = Event::Error {
                request_id: None,
                code: failure.code().into(),
                message: format!("unsupported protocol version {supplied}; expected {required}"),
                recoverable: false,
            };
            let output = std::io::stdout();
            let mut locked_output = output.lock();
            if let Err(write_failure) = ipc::write_event(&mut locked_output, &notification) {
                eprintln!("failed to write protocol error: {write_failure}");
            }
        }
        _ => eprintln!("{failure}"),
    }
}
