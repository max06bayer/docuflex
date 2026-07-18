use std::env;
use std::path::PathBuf;
use std::process::{exit, Command};

fn main() {
    let executable = env::current_exe().expect("Could not locate the pdf2htmlEX launcher");
    let native = executable
        .parent()
        .map(|directory| directory.join("pdf2htmlEX-native.exe"))
        .unwrap_or_else(|| PathBuf::from("pdf2htmlEX-native.exe"));

    let mut normalized = Vec::new();
    let mut arguments = env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        let option = argument.to_string_lossy();
        if option == "--quiet" || option == "--embed" {
            let _ = arguments.next();
            continue;
        }
        normalized.push(argument);
    }

    match Command::new(native).args(normalized).status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("Could not start bundled pdf2htmlEX: {error}");
            exit(1);
        }
    }
}
