fn main() {
    // Icons are embedded at compile time; rebuild when they change.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
