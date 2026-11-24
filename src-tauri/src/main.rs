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

    winkit_lib::run();
}
