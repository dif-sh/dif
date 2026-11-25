//! `dif init --json` install step, run through the real binary.

use std::path::Path;
use std::process::Command;

fn init_json(dir: &Path, extra: &[&str]) -> (serde_json::Value, i32) {
    // An empty PATH makes any package-manager spawn fail.
    let empty_path = tempfile::TempDir::new().unwrap();
    let out = Command::new(env!("CARGO_BIN_EXE_dif"))
        .args(["--json", "init"])
        .args(extra)
        .current_dir(dir)
        .env("PATH", empty_path.path())
        .env_remove("npm_config_user_agent")
        .output()
        .expect("run dif");
    let stdout = String::from_utf8(out.stdout).unwrap();
    let json = serde_json::from_str(&stdout)
        .unwrap_or_else(|e| panic!("stdout is not JSON ({e}): {stdout}"));
    (json, out.status.code().unwrap())
}

fn app(package_json: &str) -> tempfile::TempDir {
    let tmp = tempfile::TempDir::new().unwrap();
    std::fs::write(tmp.path().join("package.json"), package_json).unwrap();
    tmp
}

#[test]
fn json_install_step_uses_lockfile_manager() {
    let tmp = app("{}");
    std::fs::write(tmp.path().join("pnpm-lock.yaml"), "").unwrap();
    let (json, code) = init_json(tmp.path(), &["--framework", "react"]);
    assert_eq!(code, 0);
    assert_eq!(json["next"][0], "pnpm add @dif.sh/sdk @dif.sh/react");
    assert_eq!(json["installed"], serde_json::json!([]));
    assert!(!tmp.path().join("node_modules").exists());
}

#[test]
fn json_skips_installed_packages() {
    let tmp = app(r#"{"dependencies":{"@dif.sh/sdk":"^0.9.0"}}"#);
    let (json, _) = init_json(tmp.path(), &["--framework", "sdk"]);
    let next = json["next"].as_array().unwrap();
    assert_eq!(next.len(), 2);
    assert!(next[0].as_str().unwrap().starts_with("dif new"));
}

#[test]
fn json_without_package_json_has_no_install_step() {
    let tmp = tempfile::TempDir::new().unwrap();
    let (json, _) = init_json(tmp.path(), &["--framework", "react"]);
    assert_eq!(json["next"].as_array().unwrap().len(), 2);
}

#[test]
fn json_install_keeps_stdout_json() {
    let tmp = app("{}");
    let (json, code) = init_json(tmp.path(), &["--install", "--framework", "sdk"]);
    assert_eq!(code, 0);
    assert_eq!(json["installed"], serde_json::json!([]));
    assert_eq!(json["next"][0], "npm install @dif.sh/sdk");
}
