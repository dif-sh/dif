//! Discovery of `dif/audiences/<slug>.ts` resolver files.
//!
//! Each file under `dif/audiences/` provides the runtime implementation for a
//! single audience attribute declared in `dif/config.yaml`. Rust treats the
//! file as opaque — the TS toolchain is responsible for type-checking the
//! exported resolver. Here we only enumerate filenames so `validate` can pair
//! every declared attribute with an implementation, and so `codegen` can
//! tree-shake the imports it emits.

use std::path::{Path, PathBuf};

/// One discovered audience resolver file.
#[derive(Debug, Clone)]
pub struct AudienceFile {
    /// Filename stem, which is the canonical attribute name. Must match a
    /// `config.audience_attributes[].name` entry.
    pub slug: String,
    /// Absolute path to the `.ts` file on disk.
    pub path: PathBuf,
}

/// Enumerate `*.ts` files under `dir` (typically `dif/audiences/`). Returns an empty vector if `dir`
/// does not exist — a project without any audience files is a valid state
/// (validation will then flag any declared attribute as missing).
///
/// Order is sorted by slug so generated artifacts are deterministic.
pub fn load_audience_files(dir: &Path) -> Vec<AudienceFile> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("ts") {
            continue;
        }
        let Some(slug) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        out.push(AudienceFile {
            slug: slug.to_string(),
            path: path.clone(),
        });
    }
    out.sort_by(|a, b| a.slug.cmp(&b.slug));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn returns_empty_when_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let files = load_audience_files(&tmp.path().join("nope"));
        assert!(files.is_empty());
    }

    #[test]
    fn enumerates_only_ts_files() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("audiences");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("device_type.ts"), "export default () => null;").unwrap();
        fs::write(dir.join("locale.ts"), "export default () => null;").unwrap();
        fs::write(dir.join("README.md"), "# notes").unwrap();
        fs::write(dir.join("ignored.js"), "module.exports = () => null").unwrap();

        let files = load_audience_files(&dir);
        let slugs: Vec<&str> = files.iter().map(|f| f.slug.as_str()).collect();
        assert_eq!(slugs, vec!["device_type", "locale"]);
    }

    #[test]
    fn sorts_by_slug_for_deterministic_output() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("audiences");
        fs::create_dir_all(&dir).unwrap();
        for slug in ["zulu", "alpha", "mike"] {
            fs::write(dir.join(format!("{slug}.ts")), "export default () => null;").unwrap();
        }
        let files = load_audience_files(&dir);
        let slugs: Vec<&str> = files.iter().map(|f| f.slug.as_str()).collect();
        assert_eq!(slugs, vec!["alpha", "mike", "zulu"]);
    }
}
