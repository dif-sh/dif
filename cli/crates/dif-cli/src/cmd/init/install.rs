//! Package-manager detection and install commands for `dif init`.
//! Pure logic only; the install runs in [`super`].

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

/// Pick the manager from the files in the project folder.
/// The lockfile wins, because the project already uses it.
pub fn detect_package_manager(files: &[&str], user_agent: Option<&str>) -> PackageManager {
    let lockfiles = [
        ("pnpm-lock.yaml", PackageManager::Pnpm),
        ("yarn.lock", PackageManager::Yarn),
        ("bun.lock", PackageManager::Bun),
        ("bun.lockb", PackageManager::Bun),
        ("package-lock.json", PackageManager::Npm),
    ];
    if let Some((_, pm)) = lockfiles.iter().find(|(name, _)| files.contains(name)) {
        return *pm;
    }
    match user_agent.and_then(|ua| ua.split('/').next()) {
        Some("pnpm") => PackageManager::Pnpm,
        Some("yarn") => PackageManager::Yarn,
        Some("bun") => PackageManager::Bun,
        _ => PackageManager::Npm,
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
    fn missing_with_bad_json_wants_all() {
        assert_eq!(
            missing_packages("not json", &["@dif.sh/sdk"]),
            vec!["@dif.sh/sdk"]
        );
    }
}
