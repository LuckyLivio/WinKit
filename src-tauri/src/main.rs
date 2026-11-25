#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args
        .iter()
        .any(|a| a == winkit_lib::pdf_worker::PDF_WORKER_FLAG)
    {
        let mut resource_dir: Option<PathBuf> = None;
        for pair in args.windows(2) {
            if pair[0] == "--pdf-resource-dir" {
                resource_dir = Some(PathBuf::from(&pair[1]));
            }
        }
        let code = winkit_lib::pdf_worker::run_pdf_worker_stdio_loop(resource_dir.as_deref());
        std::process::exit(code);
    }

    if args
        .iter()
        .any(|a| a == winkit_lib::pdf_qpdf::QPDF_WORKER_FLAG)
    {
        let mut resource_dir: Option<PathBuf> = None;
        for pair in args.windows(2) {
            if pair[0] == "--pdf-resource-dir" {
                resource_dir = Some(PathBuf::from(&pair[1]));
            }
        }
        let code = winkit_lib::pdf_qpdf::run_qpdf_worker_stdio(resource_dir.as_deref());
        std::process::exit(code);
    }

    if args
        .iter()
        .any(|a| a == winkit_lib::ocr_worker::OCR_WORKER_FLAG)
    {
        let mut resource_dir: Option<PathBuf> = None;
        for pair in args.windows(2) {
            if pair[0] == "--ocr-resource-dir" {
                resource_dir = Some(PathBuf::from(&pair[1]));
            }
        }
        let code = winkit_lib::ocr_worker::run_ocr_worker_stdio_loop(resource_dir.as_deref());
        std::process::exit(code);
    }

    if args
        .iter()
        .any(|a| a == winkit_lib::asr_worker::ASR_WORKER_FLAG)
    {
        let mut resource_dir: Option<PathBuf> = None;
        for pair in args.windows(2) {
            if pair[0] == "--asr-resource-dir" {
                resource_dir = Some(PathBuf::from(&pair[1]));
            }
        }
        let code = winkit_lib::asr_worker::run_asr_worker_stdio_loop(resource_dir.as_deref());
        std::process::exit(code);
    }

    if args
        .iter()
        .any(|a| a == winkit_lib::matting_worker::MATTING_WORKER_FLAG)
    {
        let mut resource_dir: Option<PathBuf> = None;
        for pair in args.windows(2) {
            if pair[0] == "--matting-resource-dir" {
                resource_dir = Some(PathBuf::from(&pair[1]));
            }
        }
        let code =
            winkit_lib::matting_worker::run_matting_worker_stdio_loop(resource_dir.as_deref());
        std::process::exit(code);
    }

    if args
        .iter()
        .any(|a| a == winkit_lib::tts_worker::TTS_WORKER_FLAG)
    {
        let code = winkit_lib::tts_worker::run_tts_worker_stdio_loop();
        std::process::exit(code);
    }

    winkit_lib::run();
}
