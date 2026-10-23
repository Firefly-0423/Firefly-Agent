use std::{
    fs, os::windows::ffi::OsStrExt, path::{Path, PathBuf},
    sync::{mpsc::Sender, Arc, Mutex}, thread,
};
use windows::{
    core::{HRESULT, PCWSTR},
    Win32::{
        Foundation::GENERIC_WRITE,
        Graphics::Imaging::{
            CLSID_WICImagingFactory, GUID_ContainerFormatPng, GUID_WICPixelFormat32bppBGRA,
            IWICBitmapEncoder, IWICBitmapFrameEncode, IWICImagingFactory, IWICStream, WICBitmapEncoderNoCache,
        },
        System::Com::{
            StructuredStorage::IPropertyBag2, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
            CoCreateInstance, CoInitializeEx, CoUninitialize,
        },
    },
};
use crate::{error::HelperError, protocol::Event, request::RequestRegistry, win::capture::CpuBgraFrame};

pub struct EncodeJob {
    pub request_id: String,
    pub file_name: String,
    pub output_dir: PathBuf,
    /// Pixels move to the worker without a second image copy.
    pub frame: CpuBgraFrame,
    pub has_annotations: bool,
}

pub fn new_png_file_name() -> String { format!("{}.png", uuid::Uuid::new_v4()) }

pub fn spawn_encode_job(work: EncodeJob, event_tx: Sender<Event>, registry: Arc<Mutex<RequestRegistry>>) {
    let failed_id = work.request_id.clone();
    let worker_output = event_tx.clone();
    let worker_requests = Arc::clone(&registry);
    let launched = thread::Builder::new().name(String::from("firefly-encode")).spawn(move || {
        let terminal = match run_encode_job(&work) {
            Err(encoding_failure) => Event::Error {
                request_id: Some(work.request_id.clone()),
                code: String::from("encode-failed"),
                message: encoding_failure.to_string(),
                recoverable: false,
            },
            Ok(()) => Event::Completed {
                request_id: work.request_id.clone(),
                file_name: Some(work.file_name),
                width: work.frame.width,
                height: work.frame.height,
                mime: "image/png",
                clipboard_written: true,
                has_annotations: work.has_annotations,
            },
        };
        let _ = worker_output.send(terminal);
        finalize_registry(&worker_requests, &work.request_id, "complete");
    });
    if let Err(spawn_failure) = launched {
        let notification = Event::Error {
            request_id: Some(failed_id.clone()),
            code: String::from("encode-failed"),
            message: format!("failed to spawn encoder: {spawn_failure}"),
            recoverable: false,
        };
        let _ = event_tx.send(notification);
        finalize_registry(&registry, &failed_id, "cancel");
    }
}

fn finalize_registry(registry: &Arc<Mutex<RequestRegistry>>, request_id: &str, mode: &str) {
    let mut locked = match registry.lock() {
        Ok(locked) => locked,
        Err(unavailable) => {
            eprintln!("firefly-screenshot: encoder finalize lock unavailable for {request_id}: {unavailable}");
            return;
        }
    };
    let finished = if mode == "complete" { locked.complete(request_id, None) } else { locked.cancel(request_id, mode) };
    if let Err(failure) = finished {
        eprintln!("firefly-screenshot: encoder finalize ({mode}) for {request_id} failed: {failure}");
    }
}

struct ComGuard { uninitialize: bool }

impl ComGuard {
    fn initialize() -> Result<Self, HelperError> {
        // SAFETY: This worker initializes its own apartment with no reserved data.
        let status = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if status.is_ok() {
            return Ok(Self { uninitialize: true });
        }
        if status == HRESULT(0x0000_0001) {
            return Ok(Self { uninitialize: false });
        }
        Err(HelperError::CaptureFailed(format!("CoInitializeEx failed: {status:?}")))
    }
}

impl Drop for ComGuard {
    fn drop(&mut self) {
        if self.uninitialize {
            // SAFETY: This guard lives on the thread that initialized COM.
            unsafe { CoUninitialize() };
        }
    }
}

fn run_encode_job(work: &EncodeJob) -> Result<(), HelperError> {
    let _apartment = ComGuard::initialize()?;
    if work.frame.width == 0 || work.frame.height == 0 {
        return Err(HelperError::CaptureFailed(String::from("encoder received an empty frame")));
    }
    fs::create_dir_all(&work.output_dir).map_err(|io_failure| HelperError::CaptureFailed(format!(
        "create output dir {} failed: {io_failure}", work.output_dir.display()
    )))?;
    // SAFETY: COM is initialized here and the requested interface belongs to WIC.
    let imaging: IWICImagingFactory = unsafe { CoCreateInstance(&CLSID_WICImagingFactory, None, CLSCTX_INPROC_SERVER) }
        .map_err(|factory_failure| HelperError::CaptureFailed(format!("CoCreateInstance(WICImagingFactory) failed: {factory_failure}")))?;
    let partial = work.output_dir.join(format!("{}.tmp", work.file_name));
    let destination = work.output_dir.join(&work.file_name);
    if let Err(encoding_failure) = encode_to_path(&imaging, &work.frame, &partial) {
        let _ = fs::remove_file(&partial);
        return Err(encoding_failure);
    }
    match fs::rename(&partial, &destination) {
        Ok(()) => Ok(()),
        Err(rename_failure) => {
            let _ = fs::remove_file(&partial);
            Err(HelperError::CaptureFailed(format!("atomic rename to {} failed: {rename_failure}", destination.display())))
        }
    }
}

fn wic_failure(operation: &str, failure: windows::core::Error) -> HelperError {
    HelperError::CaptureFailed(format!("WIC {operation} failed: {failure}"))
}

fn encode_to_path(factory: &IWICImagingFactory, frame: &CpuBgraFrame, path: &Path) -> Result<(), HelperError> {
    // SAFETY: Each COM interface below remains owned through its last use.
    let sink: IWICStream = unsafe { factory.CreateStream() }.map_err(|failure| wic_failure("CreateStream", failure))?;
    let filename: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe { sink.InitializeFromFilename(PCWSTR(filename.as_ptr()), GENERIC_WRITE.0) }
        .map_err(|open_failure| HelperError::CaptureFailed(format!("WIC stream init from {} failed: {open_failure}", path.display())))?;
    let png: IWICBitmapEncoder = unsafe { factory.CreateEncoder(&GUID_ContainerFormatPng, std::ptr::null()) }
        .map_err(|failure| wic_failure("CreateEncoder(PNG)", failure))?;
    unsafe { png.Initialize(&sink, WICBitmapEncoderNoCache) }.map_err(|failure| wic_failure("encoder Initialize", failure))?;
    let mut created: Option<IWICBitmapFrameEncode> = None;
    let mut properties: Option<IPropertyBag2> = None;
    unsafe { png.CreateNewFrame(&mut created, &mut properties) }.map_err(|failure| wic_failure("CreateNewFrame", failure))?;
    let image = created.expect("CreateNewFrame returned null frame encoder");
    unsafe { image.Initialize(None::<&IPropertyBag2>) }.map_err(|failure| wic_failure("frame Initialize", failure))?;
    let (columns, rows) = (frame.width, frame.height);
    let mut negotiated = GUID_WICPixelFormat32bppBGRA;
    unsafe { image.SetSize(columns, rows) }.map_err(|failure| wic_failure("SetSize", failure))?;
    unsafe { image.SetPixelFormat(&mut negotiated) }.map_err(|failure| wic_failure("SetPixelFormat", failure))?;
    if negotiated != GUID_WICPixelFormat32bppBGRA {
        return Err(HelperError::CaptureFailed(format!("WIC rejected 32bppBGRA pixel format; got {negotiated:?}")));
    }
    let row_bytes = frame.width * 4;
    let required = frame.height.checked_mul(row_bytes).ok_or_else(|| HelperError::EncodeFailed(format!(
        "encoder pixel buffer overflow computing {}*{}", frame.height, row_bytes
    )))?;
    let actual = frame.pixels.len() as u32;
    if actual != required {
        return Err(HelperError::CaptureFailed(format!("encoder pixel buffer mismatch: bytes={actual} expected={required}")));
    }
    unsafe { image.WritePixels(rows, row_bytes, frame.pixels.as_slice()) }.map_err(|failure| wic_failure("WritePixels", failure))?;
    unsafe { image.Commit() }.map_err(|failure| wic_failure("frame Commit", failure))?;
    unsafe { png.Commit() }.map_err(|failure| wic_failure("encoder Commit", failure))?;
    Ok(())
}
