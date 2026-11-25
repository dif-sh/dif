//! Package-manager detection and install commands for `dif init`.
//! Pure logic only; the install runs in [`super`].

use std::path::Path;

/// A JS package manager that `dif init` can install with.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PackageManager {
    Npm,
    Pnpm,
    Yarn,
    Bun,
}

impl PackageManager {
    /// The command name, as typed in a shell.
    pub fn name(self) -> &'static str {
        match self {
            PackageManager::Npm => "npm",
            PackageManager::Pnpm => "pnpm",
            PackageManager::Yarn => "yarn",
            PackageManager::Bun => "bun",
        }
    }

    /// The program and arguments that add `packages`.
    pub fn add_args(self, packages: &[&str]) -> Vec<String> {
        let verb = match self {
            PackageManager::Npm => "install",
            _ => "add",
        };
        [self.name(), verb]
            .into_iter()
            .chain(packages.iter().copied())
            .map(String::from)
            .collect()
    }

    /// [`Self::add_args`] as one shell line.
    pub fn add_line(self, packages: &[&str]) -> String {
        self.add_args(packages).join(" ")
    }
}

const LOCKFILES: [(&str, PackageManager); 5] = [
    ("pnpm-lock.yaml", PackageManager::Pnpm),
    ("yarn.lock", PackageManager::Yarn),
    ("bun.lock", PackageManager::Bun),
    ("bun.lockb", PackageManager::Bun),
    ("package-lock.json", PackageManager::Npm),
];

/// Pick the manager from a lockfile, then the user agent.
/// The lockfile wins, because the project uses it.
pub fn detect_package_manager(files: &[&str], user_agent: Option<&str>) -> PackageManager {
    if let Some((_, pm)) = LOCKFILES.iter().find(|(name, _)| files.contains(name)) {
        return *pm;
    }
    match user_agent.and_then(|ua| ua.split('/').next()) {
        Some("pnpm") => PackageManager::Pnpm,
        Some("yarn") => PackageManager::Yarn,
        Some("bun") => PackageManager::Bun,
        _ => PackageManager::Npm,
    }
}

/// Like [`detect_package_manager`], for the folder `cwd`.
/// A monorepo keeps its lockfile at the repo root.
pub fn detect_in(cwd: &Path, user_agent: Option<&str>) -> PackageManager {
    let names = |dir: &Path| -> Vec<String> {
        std::fs::read_dir(dir)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|e| e.file_name().into_string().ok())
                    .collect()
            })
            .unwrap_or_default()
    };
    for dir in cwd.ancestors() {
        let files = names(dir);
        let has = |name: &str| files.iter().any(|f| f == name);
        if LOCKFILES.iter().any(|(name, _)| has(name)) {
            let files: Vec<&str> = files.iter().map(String::as_str).collect();
            return detect_package_manager(&files, user_agent);
        }
        if has(".git") {
            break;
        }
    }
    detect_package_manager(&[], user_agent)
}

/// The program and arguments to start `args` on this OS.
/// Windows needs cmd to find the .cmd shims of npm and yarn.
pub fn command_for(args: Vec<String>, windows: bool) -> Vec<String> {
    if windows {
        ["cmd", "/C"]
            .into_iter()
            .map(String::from)
            .chain(args)
            .collect()
    } else {
        args
    }
}

/// The packages in `wanted` that `package_json` does not list yet.
pub fn missing_packages<'a>(package_json: &str, wanted: &[&'a str]) -> Vec<&'a str> {
    let pkg = serde_json::from_str::<serde_json::Value>(package_json).unwrap_or_default();
    let listed = |name: &str| {
        ["dependencies", "devDependencies"]
            .iter()
            .any(|field| pkg.get(field).and_then(|d| d.get(name)).is_some())
    };
    wanted
        .iter()
        .copied()
        .filter(|name| !listed(name))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lockfile_picks_the_manager() {
        assert_eq!(
            detect_package_manager(&["pnpm-lock.yaml"], None),
            PackageManager::Pnpm
        );
        assert_eq!(
            detect_package_manager(&["yarn.lock"], None),
            PackageManager::Yarn
        );
        assert_eq!(
            detect_package_manager(&["bun.lock"], None),
            PackageManager::Bun
        );
        assert_eq!(
            detect_package_manager(&["bun.lockb"], None),
            PackageManager::Bun
        );
        assert_eq!(
            detect_package_manager(&["package-lock.json"], None),
            PackageManager::Npm
        );
    }

    #[test]
    fn lockfile_beats_user_agent() {
        let ua = Some("npm/10.8.2 node/v22.11.0 darwin arm64 workspaces/false");
        assert_eq!(
            detect_package_manager(&["pnpm-lock.yaml"], ua),
            PackageManager::Pnpm
        );
    }

    #[test]
    fn user_agent_used_without_lockfile() {
        let pnpm = Some("pnpm/9.12.0 npm/? node/v22.11.0 darwin arm64");
        let yarn = Some("yarn/4.5.0 npm/? node/v22.11.0 darwin arm64");
        let bun = Some("bun/1.1.30 npm/? node/v22.6.0 darwin arm64");
        assert_eq!(detect_package_manager(&[], pnpm), PackageManager::Pnpm);
        assert_eq!(detect_package_manager(&[], yarn), PackageManager::Yarn);
        assert_eq!(detect_package_manager(&[], bun), PackageManager::Bun);
    }

    #[test]
    fn defaults_to_npm() {
        assert_eq!(detect_package_manager(&[], None), PackageManager::Npm);
        assert_eq!(
            detect_package_manager(&[], Some("garbage")),
            PackageManager::Npm
        );
    }

    #[test]
    fn add_line_per_manager() {
        let pkgs = ["@dif.sh/sdk", "@dif.sh/react"];
        assert_eq!(
            PackageManager::Npm.add_line(&pkgs),
            "npm install @dif.sh/sdk @dif.sh/react"
        );
        assert_eq!(
            PackageManager::Pnpm.add_line(&pkgs),
            "pnpm add @dif.sh/sdk @dif.sh/react"
        );
        assert_eq!(
            PackageManager::Yarn.add_line(&pkgs),
            "yarn add @dif.sh/sdk @dif.sh/react"
        );
        assert_eq!(
            PackageManager::Bun.add_line(&pkgs),
            "bun add @dif.sh/sdk @dif.sh/react"
        );
    }

    #[test]
    fn missing_skips_deps_and_dev_deps() {
        let pkg = r#"{"dependencies":{"@dif.sh/sdk":"^0.9.0"},"devDependencies":{"@dif.sh/react":"^0.9.0"}}"#;
        assert!(missing_packages(pkg, &["@dif.sh/sdk", "@dif.sh/react"]).is_empty());
        let pkg = r#"{"dependencies":{"react":"^19"}}"#;
        assert_eq!(
            missing_packages(pkg, &["@dif.sh/sdk", "@dif.sh/react"]),
            vec!["@dif.sh/sdk", "@dif.sh/react"]
        );
    }

    #[test]
    fn lockfile_found_in_a_parent_folder() {
        let root = tempfile::TempDir::new().unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        std::fs::write(root.path().join("pnpm-lock.yaml"), "").unwrap();
        let web = root.path().join("apps/web");
        std::fs::create_dir_all(&web).unwrap();
        assert_eq!(detect_in(&web, None), PackageManager::Pnpm);
    }

    #[test]
    fn lockfile_search_stops_at_the_repo_root() {
        let outer = tempfile::TempDir::new().unwrap();
        std::fs::write(outer.path().join("yarn.lock"), "").unwrap();
        let repo = outer.path().join("repo");
        std::fs::create_dir_all(repo.join(".git")).unwrap();
        assert_eq!(detect_in(&repo, None), PackageManager::Npm);
        let pnpm = Some("pnpm/10.0.0 npm/? node/v22");
        assert_eq!(detect_in(&repo, pnpm), PackageManager::Pnpm);
    }

    #[test]
    fn windows_runs_through_cmd() {
        let args = PackageManager::Npm.add_args(&["@dif.sh/sdk"]);
        assert_eq!(
            command_for(args.clone(), true),
            vec!["cmd", "/C", "npm", "install", "@dif.sh/sdk"]
        );
        assert_eq!(
            command_for(args, false),
            vec!["npm", "install", "@dif.sh/sdk"]
        );
    }

    #[test]
    fn missing_with_bad_json_wants_all() {
        assert_eq!(
            missing_packages("not json", &["@dif.sh/sdk"]),
            vec!["@dif.sh/sdk"]
        );
    }
}
