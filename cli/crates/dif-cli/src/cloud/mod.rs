//! dif.sh Cloud access for the cloud verbs (`dif auth`, `dif connect`).
//!
//! Local verbs must not use this module: they never touch the network.

pub mod credentials;
#[cfg(test)]
pub mod fake_server;

use console::style;
use serde_json::{json, Map, Value};
use std::process::ExitCode;
use std::time::Duration;

pub use credentials::{CloudEnv, Session, Source};

pub const DEFAULT_CLOUD_URL: &str = "https://cloud.dif.sh";

/// A failed cloud call, before it becomes a contract error code.
#[derive(Debug)]
pub enum ApiError {
    /// DNS, TLS, timeout or connection failure.
    Unreachable(String),
    /// The server answered with a non-2xx status.
    Status {
        status: u16,
        code: Option<String>,
        retry_after: Option<u64>,
    },
    /// A 2xx answer whose body is not a JSON object.
    BadBody,
}

impl ApiError {
    /// The server's `error` code, if it sent one.
    pub fn code(&self) -> Option<&str> {
        match self {
            ApiError::Status { code, .. } => code.as_deref(),
            _ => None,
        }
    }

    /// Map to the shared cloud error codes of the CLI contract.
    pub fn into_failure(self) -> Failure {
        match self {
            ApiError::Unreachable(msg) => Failure::new(
                "cloud_unreachable",
                1,
                format!("could not reach dif.sh Cloud: {msg}"),
            ),
            ApiError::BadBody => Failure::new(
                "cloud_error",
                1,
                "dif.sh Cloud returned a response the CLI can't read",
            ),
            ApiError::Status {
                status,
                code,
                retry_after,
            } => match status {
                401 => Failure::new(
                    "token_invalid",
                    2,
                    "the token was rejected; run dif auth login",
                ),
                403 => Failure::new("forbidden", 1, "the token lacks the role or scope"),
                429 => {
                    let mut f = Failure::new("rate_limited", 1, "too many requests; retry later");
                    if let Some(secs) = retry_after {
                        f = f.with("retry_after", json!(secs));
                    }
                    f
                }
                _ => Failure::new(
                    "cloud_error",
                    1,
                    format!(
                        "dif.sh Cloud answered HTTP {status} ({})",
                        code.as_deref().unwrap_or("no error code")
                    ),
                ),
            },
        }
    }
}

/// Blocking JSON client for one Cloud base URL.
pub struct Client {
    base: String,
    token: Option<String>,
    agent: ureq::Agent,
}

impl Client {
    pub fn new(base: &str, token: Option<String>) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(30)))
            .http_status_as_error(false)
            .user_agent(format!("dif/{}", env!("CARGO_PKG_VERSION")))
            .build()
            .into();
        Client {
            base: base.trim_end_matches('/').to_string(),
            token,
            agent,
        }
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    pub fn get(&self, path: &str) -> Result<Value, ApiError> {
        let mut req = self.agent.get(format!("{}{path}", self.base));
        if let Some(t) = &self.token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        read(req.call())
    }

    pub fn post(&self, path: &str, body: &Value) -> Result<Value, ApiError> {
        let mut req = self
            .agent
            .post(format!("{}{path}", self.base))
            .header("Content-Type", "application/json");
        if let Some(t) = &self.token {
            req = req.header("Authorization", format!("Bearer {t}"));
        }
        read(req.send(body.to_string()))
    }
}

fn read(result: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<Value, ApiError> {
    let mut resp = result.map_err(|e| ApiError::Unreachable(e.to_string()))?;
    let status = resp.status().as_u16();
    let retry_after = resp
        .headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse().ok());
    let text = resp.body_mut().read_to_string().unwrap_or_default();
    let body: Option<Value> = serde_json::from_str(&text).ok().filter(Value::is_object);
    if (200..300).contains(&status) {
        return body.ok_or(ApiError::BadBody);
    }
    let field = |k: &str| body.as_ref().and_then(|b| b.get(k).cloned());
    Err(ApiError::Status {
        status,
        code: field("error").and_then(|v| v.as_str().map(String::from)),
        retry_after: retry_after.or_else(|| field("retry_after").and_then(|v| v.as_u64())),
    })
}

/// A contract error: a stable `error` code, a message and an exit code.
#[derive(Debug)]
pub struct Failure {
    pub code: &'static str,
    pub message: String,
    pub exit: u8,
    pub extra: Map<String, Value>,
}

impl Failure {
    pub fn new(code: &'static str, exit: u8, message: impl Into<String>) -> Self {
        Failure {
            code,
            message: message.into(),
            exit,
            extra: Map::new(),
        }
    }

    pub fn with(mut self, key: &str, value: Value) -> Self {
        self.extra.insert(key.to_string(), value);
        self
    }

    pub fn to_json(&self) -> Value {
        let mut obj = self.extra.clone();
        obj.insert("ok".into(), json!(false));
        obj.insert("error".into(), json!(self.code));
        obj.insert("message".into(), json!(self.message));
        Value::Object(obj)
    }

    pub fn report(&self, json: bool) -> ExitCode {
        if json {
            println!("{}", serde_json::to_string_pretty(&self.to_json()).unwrap());
        } else {
            eprintln!("{} {}", style("✗").red().bold(), self.message);
        }
        ExitCode::from(self.exit)
    }
}

/// Map an authenticated call's error. Drop a rejected file token.
pub fn rejected(env: &CloudEnv, session: &Session, e: ApiError) -> Failure {
    let failure = e.into_failure();
    if failure.code == "token_invalid" && session.source == Source::File {
        // The token_invalid code matters more than a failed delete.
        let _ = env.delete_credential();
    }
    failure
}

/// Print a success object in JSON mode. Return true when printed.
pub fn print_json(json: bool, value: &Value) -> bool {
    if json {
        println!("{}", serde_json::to_string_pretty(value).unwrap());
    }
    json
}
