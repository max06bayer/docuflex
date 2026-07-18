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
    let mut data_directory = None;
    let mut arguments = env::args_os().skip(1);
    while let Some(argument) = arguments.next() {
        let option = argument.to_string_lossy();
        if option == "--quiet" || option == "--embed" {
            let _ = arguments.next();
            continue;
        }
        if option == "--data-dir" {
            normalized.push(argument);
            if let Some(value) = arguments.next() {
                data_directory = Some(PathBuf::from(&value));
                normalized.push(value);
            }
            continue;
        }
        normalized.push(argument);
    }

    let mut command = Command::new(native);
    command.args(normalized);
    if let Some(directory) = data_directory {
        command.current_dir(directory);
    }
    match command.status() {
        Ok(status) => exit(status.code().unwrap_or(1)),
        Err(error) => {
            eprintln!("Could not start bundled pdf2htmlEX: {error}");
            exit(1);
        }
    }
}
