fn main() {
    tauri_build::build();
    // Rebuild when the compiled worker sidecar changes so include_bytes! stays in sync.
    println!("cargo:rerun-if-changed=scripts/worker-sidecar.exe");
    println!("cargo:rerun-if-changed=scripts/worker-sidecar");
}
