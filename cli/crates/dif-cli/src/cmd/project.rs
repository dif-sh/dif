//! Project slug resolution for project-scoped cloud verbs.

use crate::cloud::{rejected, ApiError, Client, CloudEnv, Failure, Session};
use serde_json::Value;
use std::path::Path;

pub(crate) fn list_projects(client: &Client, org: Option<&str>) -> Result<Vec<Value>, ApiError> {
    let path = match org {
        Some(o) => format!("/v1/cli/projects?org={o}"),
        None => "/v1/cli/projects".to_string(),
    };
    Ok(client.get(&path)?["projects"]
        .as_array()
        .cloned()
        .unwrap_or_default())
}

pub(crate) fn needs_selection(orgs: &[Value], projects: &[Value], message: &str) -> Failure {
    let pick = |v: &Value, keys: &[&str]| -> Value {
        keys.iter()
            .map(|k| (k.to_string(), v.get(*k).cloned().unwrap_or(Value::Null)))
            .collect::<serde_json::Map<_, _>>()
            .into()
    };
    Failure::new("needs_selection", 2, message)
        .with(
            "orgs",
            orgs.iter().map(|o| pick(o, &["slug", "name"])).collect(),
        )
        .with(
            "projects",
            projects
                .iter()
                .map(|p| pick(p, &["slug", "name", "org", "repo"]))
                .collect(),
        )
}

pub(crate) fn detect_github_repo(root: &Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["remote", "get-url", "origin"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_github_remote(&String::from_utf8_lossy(&out.stdout))
}

/// `owner/repo` when the remote points at GitHub.
fn parse_github_remote(url: &str) -> Option<String> {
    let url = url.trim();
    let (authority, path) = match url.split_once("://") {
        Some((_, rest)) => rest.split_once('/')?,
        // scp-like form: `git@github.com:owner/repo.git`.
        None => url.split_once(':')?,
    };
    let host = authority.rsplit('@').next()?.split(':').next()?;
    if !host.eq_ignore_ascii_case("github.com") {
        return None;
    }
    let path = path.trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

/// A slug goes into a URL path, so refuse other shapes.
/// Cloud slugs are citext, so case does not matter.
pub(crate) fn check_slug(kind: &str, s: &str) -> Result<(), Failure> {
    let mut bytes = s.bytes();
    let ok = bytes.next().is_some_and(|b| b.is_ascii_alphanumeric())
        && bytes.all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if ok {
        return Ok(());
    }
    Err(Failure::new(
        "usage",
        2,
        format!("{kind} slug {s:?} is not valid; use letters, digits and -"),
    ))
}

enum Resolve {
    Api(ApiError),
    Fail(Failure),
}

fn resolve_inner(client: &Client, root: &Path, flag: Option<&str>) -> Result<String, Resolve> {
    if let Some(slug) = flag {
        check_slug("project", slug).map_err(Resolve::Fail)?;
        return Ok(slug.to_string());
    }
    let projects = list_projects(client, None).map_err(Resolve::Api)?;
    if let Some(slug) = pick_by_repo(&projects, detect_github_repo(root).as_deref()) {
        return Ok(slug);
    }
    if let [only] = projects.as_slice() {
        if let Some(slug) = only["slug"].as_str() {
            return Ok(slug.to_string());
        }
    }
    Err(Resolve::Fail(needs_selection(
        &[],
        &projects,
        "choose a project: pass --project <slug>",
    )))
}

/// The slug of the one project whose repo matches. No case.
fn pick_by_repo(projects: &[Value], repo: Option<&str>) -> Option<String> {
    let repo = repo?;
    let mut hits = projects.iter().filter(|p| {
        p["repo"]
            .as_str()
            .is_some_and(|r| r.eq_ignore_ascii_case(repo))
    });
    let first = hits.next()?;
    if hits.next().is_some() {
        return None;
    }
    first["slug"].as_str().map(String::from)
}

/// Session, client and slug for a project-scoped verb.
pub(crate) fn project_session(
    root: &Path,
    flag: Option<&str>,
    env: &CloudEnv,
) -> Result<(Client, Session, String), Failure> {
    let session = env
        .session()
        .ok_or_else(|| Failure::new("not_logged_in", 2, "run dif auth login"))?;
    let client = Client::new(&session.cloud_url, Some(session.token.clone()));
    let slug = resolve_inner(&client, root, flag).map_err(|e| match e {
        Resolve::Api(e) => rejected(env, &session, e),
        Resolve::Fail(f) => f,
    })?;
    Ok((client, session, slug))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::fake_server::FakeServer;
    use crate::cloud::Client;
    use serde_json::json;

    fn client(server: &FakeServer) -> Client {
        Client::new(&server.url, Some("dif_cli_x".into()))
    }

    fn resolve_project(
        client: &Client,
        root: &Path,
        flag: Option<&str>,
    ) -> Result<String, crate::cloud::Failure> {
        resolve_inner(client, root, flag).map_err(|e| match e {
            Resolve::Api(e) => e.into_failure(),
            Resolve::Fail(f) => f,
        })
    }

    fn projects() -> Vec<Value> {
        vec![
            json!({"slug":"shop","name":"Shop","org":"acme","repo":"Acme/Shop"}),
            json!({"slug":"blog","name":"Blog","org":"acme","repo":null}),
        ]
    }

    #[test]
    fn flag_wins_without_a_request() {
        let server = FakeServer::start(|_| (500, "{}".into()));
        let slug = resolve_project(&client(&server), Path::new("."), Some("mine")).unwrap();
        assert_eq!(slug, "mine");
        assert!(server.paths().is_empty());
    }

    #[test]
    fn bad_flag_slug_is_usage_without_a_request() {
        let server = FakeServer::start(|_| (500, "{}".into()));
        for bad in ["../x", "a/b", "a?b", "-a", "", "a b", "a%2f"] {
            let f = resolve_project(&client(&server), Path::new("."), Some(bad)).unwrap_err();
            assert_eq!((f.code, f.exit), ("usage", 2), "{bad}");
        }
        assert!(server.paths().is_empty());
    }

    #[test]
    fn check_slug_matches_cloud_slugs() {
        for ok in ["shop", "acme-2", "0x", "Shop"] {
            assert!(check_slug("project", ok).is_ok(), "{ok}");
        }
        for bad in ["", "-x", "x_y", "x.y", "x/y", "é"] {
            assert!(check_slug("org", bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn single_project_is_chosen() {
        let server = FakeServer::start(|_| {
            (
                200,
                r#"{"projects":[{"slug":"only","name":"O","org":"a","repo":null}]}"#.into(),
            )
        });
        let tmp = tempfile::tempdir().unwrap();
        let slug = resolve_project(&client(&server), tmp.path(), None).unwrap();
        assert_eq!(slug, "only");
    }

    #[test]
    fn needs_selection_lists_projects_when_ambiguous() {
        let body = json!({ "projects": projects() }).to_string();
        let server = FakeServer::start(move |_| (200, body.clone()));
        let tmp = tempfile::tempdir().unwrap();
        let f = resolve_project(&client(&server), tmp.path(), None).unwrap_err();
        assert_eq!((f.code, f.exit), ("needs_selection", 2));
        assert_eq!(f.to_json()["projects"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn pick_by_repo_matches_one_without_case() {
        let p = projects();
        assert_eq!(pick_by_repo(&p, Some("Acme/Shop")).as_deref(), Some("shop"));
        assert_eq!(pick_by_repo(&p, Some("acme/shop")).as_deref(), Some("shop"));
        assert_eq!(pick_by_repo(&p, Some("acme/other")), None);
        assert_eq!(pick_by_repo(&p, None), None);
    }

    #[test]
    fn pick_by_repo_refuses_two_matches() {
        let p = vec![
            json!({"slug":"a","repo":"acme/shop"}),
            json!({"slug":"b","repo":"acme/shop"}),
        ];
        assert_eq!(pick_by_repo(&p, Some("acme/shop")), None);
    }

    #[test]
    fn parses_github_remotes() {
        for url in [
            "git@github.com:acme/shop.git",
            "https://github.com/acme/shop",
            "https://github.com/acme/shop.git/",
            "https://token@github.com/acme/shop.git",
            "ssh://git@github.com:22/acme/shop.git",
        ] {
            assert_eq!(
                parse_github_remote(url).as_deref(),
                Some("acme/shop"),
                "{url}"
            );
        }
        for url in [
            "git@gitlab.com:acme/shop.git",
            "https://github.com/acme",
            "/srv/git/shop.git",
            "C:\\repos\\shop",
        ] {
            assert_eq!(parse_github_remote(url), None, "{url}");
        }
    }
}
