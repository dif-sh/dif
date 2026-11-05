//! Local login state: the credential and the pending device login.

use super::DEFAULT_CLOUD_URL;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};

const CREDENTIALS_FILE: &str = "credentials.json";
const PENDING_FILE: &str = "pending-login.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredCredential {
    pub token: String,
    pub cloud_url: String,
    #[serde(default)]
    pub user: Option<Value>,
    #[serde(default)]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingLogin {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub interval: u64,
    pub expires_in: u64,
    pub cloud_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    File,
    Env,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::File => "file",
            Source::Env => "env",
        }
    }
}

/// The credential a cloud call uses.
#[derive(Debug, Clone)]
pub struct Session {
    pub token: String,
    pub source: Source,
    pub cloud_url: String,
    pub user: Option<Value>,
    pub expires_at: Option<String>,
}

/// The process inputs for cloud verbs, kept apart from the real env for tests.
#[derive(Debug, Clone, Default)]
pub struct CloudEnv {
    pub config_dir: Option<PathBuf>,
    pub token: Option<String>,
    pub cloud_url: Option<String>,
}

impl CloudEnv {
    pub fn from_process() -> Self {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.trim().is_empty());
        let config_root = var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .or_else(|| {
                var("HOME")
                    .or_else(|| var("USERPROFILE"))
                    .map(|h| Path::new(&h).join(".config"))
            });
        CloudEnv {
            config_dir: config_root.map(|r| r.join("dif")),
            token: var("DIF_TOKEN").map(|t| t.trim().to_string()),
            cloud_url: var("DIF_CLOUD_URL").map(|u| u.trim().trim_end_matches('/').to_string()),
        }
    }

    /// The base URL for a new login.
    pub fn login_url(&self) -> String {
        self.cloud_url
            .clone()
            .unwrap_or_else(|| DEFAULT_CLOUD_URL.to_string())
    }

    /// `DIF_TOKEN` wins over the credentials file.
    pub fn session(&self) -> Option<Session> {
        let stored = self.load_credential();
        if let Some(token) = &self.token {
            return Some(Session {
                token: token.clone(),
                source: Source::Env,
                cloud_url: self.login_url(),
                user: None,
                expires_at: None,
            });
        }
        let c = stored?;
        Some(Session {
            cloud_url: self.cloud_url.clone().unwrap_or(c.cloud_url),
            token: c.token,
            source: Source::File,
            user: c.user,
            expires_at: c.expires_at,
        })
    }

    fn path(&self, name: &str) -> Option<PathBuf> {
        self.config_dir.as_ref().map(|d| d.join(name))
    }

    pub fn load_credential(&self) -> Option<StoredCredential> {
        load(&self.path(CREDENTIALS_FILE)?)
    }

    pub fn save_credential(&self, c: &StoredCredential) -> std::io::Result<()> {
        write_private(&self.require_path(CREDENTIALS_FILE)?, c)
    }

    /// Return true when a file was there.
    pub fn delete_credential(&self) -> std::io::Result<bool> {
        remove(self.path(CREDENTIALS_FILE))
    }

    pub fn load_pending(&self) -> Option<PendingLogin> {
        load(&self.path(PENDING_FILE)?)
    }

    pub fn save_pending(&self, p: &PendingLogin) -> std::io::Result<()> {
        write_private(&self.require_path(PENDING_FILE)?, p)
    }

    pub fn delete_pending(&self) -> std::io::Result<bool> {
        remove(self.path(PENDING_FILE))
    }

    fn require_path(&self, name: &str) -> std::io::Result<PathBuf> {
        self.path(name).ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "no config directory: set HOME or XDG_CONFIG_HOME",
            )
        })
    }
}

fn load<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn remove(path: Option<PathBuf>) -> std::io::Result<bool> {
    let Some(path) = path else { return Ok(false) };
    match std::fs::remove_file(path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

/// Write via a temp file and rename, so readers never see half a token.
fn write_private<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let dir = path.parent().expect("credential path has a parent");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(dir)?;

    let tmp = path.with_extension("json.tmp");
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut file = opts.open(&tmp)?;
    file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_in(dir: &Path, token: Option<&str>) -> CloudEnv {
        CloudEnv {
            config_dir: Some(dir.join("dif")),
            token: token.map(String::from),
            cloud_url: None,
        }
    }

    fn stored(token: &str) -> StoredCredential {
        StoredCredential {
            token: token.into(),
            cloud_url: "http://localhost:4321".into(),
            user: Some(serde_json::json!({ "id": "u1", "email": "dev@example.com" })),
            expires_at: Some("2027-02-03T00:00:00Z".into()),
        }
    }

    #[test]
    fn env_token_wins_over_file() {
        let tmp = tempfile::tempdir().unwrap();
        let env = env_in(tmp.path(), Some("dif_cli_env"));
        env.save_credential(&stored("dif_cli_file")).unwrap();

        let s = env.session().unwrap();
        assert_eq!(s.token, "dif_cli_env");
        assert_eq!(s.source, Source::Env);
        assert_eq!(s.cloud_url, DEFAULT_CLOUD_URL);
    }

    #[test]
    fn file_session_keeps_its_cloud_url_unless_env_overrides() {
        let tmp = tempfile::tempdir().unwrap();
        let mut env = env_in(tmp.path(), None);
        env.save_credential(&stored("dif_cli_file")).unwrap();

        let s = env.session().unwrap();
        assert_eq!((s.token.as_str(), s.source), ("dif_cli_file", Source::File));
        assert_eq!(s.cloud_url, "http://localhost:4321");

        env.cloud_url = Some("https://other.example".into());
        assert_eq!(env.session().unwrap().cloud_url, "https://other.example");
    }

    #[test]
    fn no_token_and_no_file_is_logged_out() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(env_in(tmp.path(), None).session().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn credential_and_pending_files_are_mode_0600() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let env = env_in(tmp.path(), None);
        let dir = tmp.path().join("dif");
        env.save_credential(&stored("dif_cli_file")).unwrap();
        env.save_pending(&PendingLogin {
            device_code: "dc".into(),
            user_code: "WDJB-MJHT".into(),
            verification_uri: "u".into(),
            verification_uri_complete: "u?code".into(),
            interval: 5,
            expires_in: 600,
            cloud_url: DEFAULT_CLOUD_URL.into(),
        })
        .unwrap();

        for name in [CREDENTIALS_FILE, PENDING_FILE] {
            let mode = std::fs::metadata(dir.join(name))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{name}");
        }
    }
}
