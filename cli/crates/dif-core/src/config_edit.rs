//! In-place, comment-preserving edits to `dif/config.yaml`.
//!
//! `dif connect` and `dif init --key` both need to write the `events:` block.
//! We deliberately do *not* round-trip through `serde_yaml` — that strips the
//! teaching comments and reflows the whole file. Instead we do surgical string
//! edits (the same philosophy as [`crate::validate`]-adjacent `dif conclude`,
//! which splices frontmatter rather than reserializing).
//!
//! Two entry points:
//! - [`render_events_block`] — the canonical `events:` block *with* its leading
//!   teaching comment. Used by `dif init` (fresh file) and by the insert path of
//!   [`upsert_events_block`].
//! - [`upsert_events_block`] — edit an existing `dif/config.yaml` in place,
//!   setting mode/url/key while leaving every other byte (comments, ordering,
//!   unknown keys) untouched.

use crate::config::{Config, EventsMode};
use thiserror::Error;

/// Failure modes for [`upsert_events_block`].
#[derive(Debug, Error)]
pub enum ConfigEditError {
    /// The spliced result no longer parses as a [`Config`]. The edit is
    /// discarded and the caller must not write anything.
    #[error("edited config no longer parses: {0}")]
    Parse(#[from] serde_yaml::Error),
    /// The spliced result parsed, but the events block didn't end up with the
    /// values we asked for (e.g. an exotic pre-existing layout we couldn't
    /// splice safely). The edit is discarded.
    #[error("edited config did not take the expected events settings")]
    Verify,
}

/// The signature phrase every dif-managed events comment opens with. Used to
/// tell dif's own teaching comment apart from a user's hand-written one.
const EVENTS_COMMENT_MARKER: &str = "How events are delivered.";

/// The leading teaching comment for an events block, keyed to the mode.
fn events_comment(mode: EventsMode) -> &'static str {
    match mode {
        EventsMode::Cloud => {
            "# How events are delivered. `cloud` posts exposures and dif.track()
# metrics to dif.sh Cloud. The url is recorded here so the SDK and the cloud
# agree on where to send them."
        }
        EventsMode::Custom => {
            "# How events are delivered. `custom` calls the handlers you export from
# dif/events/exposure.ts and dif/events/track.ts — forward to Amplitude,
# Mixpanel, a webhook, or wherever you like."
        }
    }
}

/// Render the canonical `events:` block, including its leading teaching
/// comment. No trailing newline. `url`/`key` are emitted only when `Some` and
/// only for cloud mode (custom mode ignores them).
pub fn render_events_block(mode: EventsMode, url: Option<&str>, key: Option<&str>) -> String {
    let mut s = String::from(events_comment(mode));
    s.push('\n');
    match mode {
        EventsMode::Cloud => {
            s.push_str("events:\n  mode: cloud");
            if let Some(u) = url {
                s.push_str(&format!("\n  url: {u}"));
            }
            if let Some(k) = key {
                s.push_str(&format!("\n  key: {k}"));
            }
        }
        EventsMode::Custom => s.push_str("events:\n  mode: custom"),
    }
    s
}

/// Set the `events` block of an existing `config.yaml`, preserving everything
/// else byte-for-byte.
///
/// - If an `events:` block exists, its `mode`/`url`/`key` children are upserted
///   in place (values replaced, missing children appended). `url`/`key` are only
///   touched when `Some`; `mode` is always set. Interleaved comments and unknown
///   children survive untouched.
/// - If no `events:` block exists, a freshly rendered block (with its teaching
///   comment) is inserted before `build:`, or appended at EOF.
///
/// The result is re-parsed as a [`Config`] and the events settings verified
/// before returning; on any mismatch we return `Err` so the caller writes
/// nothing.
pub fn upsert_events_block(
    text: &str,
    mode: EventsMode,
    url: Option<&str>,
    key: Option<&str>,
) -> Result<String, ConfigEditError> {
    let eol = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let had_trailing_nl = text.is_empty() || text.ends_with('\n');
    let mut lines: Vec<String> = text.split_inclusive('\n').map(String::from).collect();

    match find_top_level(&lines, "events") {
        Some(header_idx) => edit_existing_block(&mut lines, header_idx, eol, mode, url, key),
        None => insert_new_block(&mut lines, eol, mode, url, key),
    }

    // Normalise interior newlines: only the original final line could lack one,
    // and if we appended after it, it's now interior and needs terminating.
    if lines.len() >= 2 {
        for i in 0..lines.len() - 1 {
            if !lines[i].ends_with('\n') {
                lines[i].push_str(eol);
            }
        }
    }

    let mut result = lines.concat();
    if !had_trailing_nl {
        // Preserve the original "no trailing newline" property.
        if let Some(stripped) = result.strip_suffix("\r\n") {
            result = stripped.to_string();
        } else if let Some(stripped) = result.strip_suffix('\n') {
            result = stripped.to_string();
        }
    }

    // Verify-after-splice: never hand back a config we can't stand behind.
    let cfg: Config = serde_yaml::from_str(&result)?;
    let events = cfg.events();
    if events.mode != mode {
        return Err(ConfigEditError::Verify);
    }
    if let Some(k) = key {
        if events.key.as_deref() != Some(k) {
            return Err(ConfigEditError::Verify);
        }
    }
    if let Some(u) = url {
        if events.url.as_deref() != Some(u) {
            return Err(ConfigEditError::Verify);
        }
    }
    Ok(result)
}

/// Upsert children within an existing `events:` block.
fn edit_existing_block(
    lines: &mut Vec<String>,
    header_idx: usize,
    eol: &str,
    mode: EventsMode,
    url: Option<&str>,
    key: Option<&str>,
) {
    // The block body runs from just after the header to the first column-0
    // non-blank line (the next top-level key or comment), or EOF.
    let block_end = lines
        .iter()
        .enumerate()
        .skip(header_idx + 1)
        .find(|(_, raw)| {
            let content = line_content(raw);
            !content.trim().is_empty() && !content.starts_with([' ', '\t'])
        })
        .map(|(i, _)| i)
        .unwrap_or(lines.len());

    // Child indentation: copy the first indented child, else two spaces.
    let indent = (header_idx + 1..block_end)
        .map(|i| line_content(&lines[i]))
        .find(|c| !c.trim().is_empty() && c.starts_with([' ', '\t']))
        .map(|c| leading_ws(c).to_string())
        .unwrap_or_else(|| "  ".to_string());

    // Index of the last non-blank child + 1 (append point), and header+1 as the
    // fallback when the block is empty.
    let mut append_at = header_idx + 1;
    for i in (header_idx + 1..block_end).rev() {
        if !line_content(&lines[i]).trim().is_empty() {
            append_at = i + 1;
            break;
        }
    }

    // The mode value before we touch it. A change means dif's leading teaching
    // comment (if that's what's there) now describes the wrong delivery mode.
    let prev_mode: Option<String> = lines[header_idx + 1..block_end].iter().find_map(|raw| {
        line_content(raw)
            .trim_start()
            .strip_prefix("mode:")
            .map(|v| v.trim().to_string())
    });

    // Replace existing children in place (no index shift), remember what's absent.
    let mut have_mode = false;
    let mut have_url = false;
    let mut have_key = false;
    for raw in lines.iter_mut().take(block_end).skip(header_idx + 1) {
        let trimmed = line_content(raw).trim_start();
        let is_mode = trimmed.starts_with("mode:");
        let is_url = trimmed.starts_with("url:");
        let is_key = trimmed.starts_with("key:");
        // `trimmed` borrows `raw`; it's unused past this point, so NLL lets us
        // reassign `*raw` below.
        if is_mode {
            have_mode = true;
            *raw = format!("{indent}mode: {}{eol}", mode_str(mode));
        } else if let (Some(u), true) = (url, is_url) {
            have_url = true;
            *raw = format!("{indent}url: {u}{eol}");
        } else if let (Some(k), true) = (key, is_key) {
            have_key = true;
            *raw = format!("{indent}key: {k}{eol}");
        }
    }

    // Append absent children (url then key) after the last child.
    let mut appended: Vec<String> = Vec::new();
    if let Some(u) = url {
        if !have_url {
            appended.push(format!("{indent}url: {u}{eol}"));
        }
    }
    if let Some(k) = key {
        if !have_key {
            appended.push(format!("{indent}key: {k}{eol}"));
        }
    }
    if !appended.is_empty() {
        splice(lines, append_at, appended);
    }
    // Missing `mode:` becomes the first child (readability), inserted last so the
    // append index above stayed valid.
    if !have_mode {
        lines.insert(
            header_idx + 1,
            format!("{indent}mode: {}{eol}", mode_str(mode)),
        );
    }

    // A genuine mode flip: refresh dif's own comment (all our inserts landed at
    // ≥ header_idx + 1, so `header_idx` still points at the header).
    if prev_mode.as_deref().is_some_and(|m| m != mode_str(mode)) {
        refresh_leading_comment(lines, header_idx, eol, mode);
    }
}

/// Replace the contiguous dif-managed comment lines directly above `events:`
/// with the comment for `mode`. No-op when there's no comment there, or when
/// it's the user's own (missing dif's marker) — we never rewrite user prose.
fn refresh_leading_comment(
    lines: &mut Vec<String>,
    header_idx: usize,
    eol: &str,
    mode: EventsMode,
) {
    let mut start = header_idx;
    while start > 0 && line_content(&lines[start - 1]).starts_with('#') {
        start -= 1;
    }
    if start == header_idx {
        return; // nothing commented directly above the header
    }
    let is_dif =
        (start..header_idx).any(|i| line_content(&lines[i]).contains(EVENTS_COMMENT_MARKER));
    if !is_dif {
        return; // a user's comment — leave it be
    }
    let fresh: Vec<String> = events_comment(mode)
        .split('\n')
        .map(|l| format!("{l}{eol}"))
        .collect();
    let tail = lines.split_off(header_idx);
    lines.truncate(start);
    lines.extend(fresh);
    lines.extend(tail);
}

/// Insert a freshly rendered block before `build:`, or append at EOF.
fn insert_new_block(
    lines: &mut Vec<String>,
    eol: &str,
    mode: EventsMode,
    url: Option<&str>,
    key: Option<&str>,
) {
    let block = render_events_block(mode, url, key).replace('\n', eol);
    let mut block_lines: Vec<String> = block.split_inclusive('\n').map(String::from).collect();
    // `block` has no trailing newline; give its last line one so it concatenates.
    if let Some(last) = block_lines.last_mut() {
        if !last.ends_with('\n') {
            last.push_str(eol);
        }
    }

    match find_top_level(lines, "build") {
        Some(build_idx) => {
            // Blank line before the block unless the preceding line is already blank.
            let mut insert: Vec<String> = Vec::new();
            let preceded_by_blank = build_idx
                .checked_sub(1)
                .map(|i| line_content(&lines[i]).trim().is_empty())
                .unwrap_or(true);
            if !preceded_by_blank {
                insert.push(eol.to_string());
            }
            insert.extend(block_lines);
            insert.push(eol.to_string()); // blank line between block and build
            splice(lines, build_idx, insert);
        }
        None => {
            // Append at EOF. Ensure a blank line of separation.
            if let Some(last) = lines.last_mut() {
                if !last.ends_with('\n') {
                    last.push_str(eol);
                }
            }
            if !lines.is_empty() {
                lines.push(eol.to_string());
            }
            lines.extend(block_lines);
        }
    }
}

/// Insert `items` into `lines` at `idx`, shifting the tail right.
fn splice(lines: &mut Vec<String>, idx: usize, items: Vec<String>) {
    let tail = lines.split_off(idx);
    lines.extend(items);
    lines.extend(tail);
}

/// First line that is a column-0 (unindented) `<key>:` mapping. Comments and
/// indented children can't match.
fn find_top_level(lines: &[String], key: &str) -> Option<usize> {
    let prefix = format!("{key}:");
    lines.iter().position(|raw| {
        let content = line_content(raw);
        !content.starts_with([' ', '\t']) && content.starts_with(&prefix)
    })
}

/// Line content with the trailing `\n` / `\r\n` removed.
fn line_content(raw: &str) -> &str {
    raw.trim_end_matches('\n').trim_end_matches('\r')
}

/// The leading whitespace run of a line's content.
fn leading_ws(content: &str) -> &str {
    let end = content
        .find(|c: char| c != ' ' && c != '\t')
        .unwrap_or(content.len());
    &content[..end]
}

fn mode_str(mode: EventsMode) -> &'static str {
    match mode {
        EventsMode::Cloud => "cloud",
        EventsMode::Custom => "custom",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PK: &str = "dif_pk_live_abc123";
    const URL: &str = "https://cloud.dif.sh";

    /// A full, valid config whose events block is `events_block` (may be empty).
    fn config_with(events_block: &str, trailing_build: bool) -> String {
        let build = if trailing_build {
            "\nbuild:\n  out: dif/generated\n  fail_on: [conflict]\n"
        } else {
            ""
        };
        format!(
            "project: demo\ndefault_surface: home\nbucketing:\n  id: user_id\n  fallback: anon_cookie\n{events_block}{build}"
        )
    }

    fn parse(text: &str) -> Config {
        serde_yaml::from_str(text).expect("valid config")
    }

    #[test]
    fn render_cloud_omits_absent_fields() {
        let block = render_events_block(EventsMode::Cloud, None, None);
        assert!(block.contains("mode: cloud"));
        assert!(!block.contains("url:"));
        assert!(!block.contains("key:"));
        assert!(!block.ends_with('\n'));
    }

    #[test]
    fn render_cloud_with_url_and_key() {
        let block = render_events_block(EventsMode::Cloud, Some(URL), Some(PK));
        assert!(block.contains("  mode: cloud"));
        assert!(block.contains(&format!("  url: {URL}")));
        assert!(block.contains(&format!("  key: {PK}")));
    }

    #[test]
    fn render_custom_ignores_url_and_key() {
        let block = render_events_block(EventsMode::Custom, Some(URL), Some(PK));
        assert!(block.contains("mode: custom"));
        assert!(!block.contains("key:"));
    }

    #[test]
    fn no_events_block_inserts_before_build() {
        let input = config_with("", true);
        let out = upsert_events_block(&input, EventsMode::Cloud, Some(URL), Some(PK)).unwrap();
        let events = out.find("events:").unwrap();
        let build = out.find("build:").unwrap();
        assert!(events < build, "events block must land before build");
        let cfg = parse(&out);
        assert_eq!(cfg.events().mode, EventsMode::Cloud);
        assert_eq!(cfg.events().key.as_deref(), Some(PK));
    }

    #[test]
    fn no_events_and_no_build_appends_at_eof() {
        let input = config_with("", false);
        let out = upsert_events_block(&input, EventsMode::Cloud, Some(URL), Some(PK)).unwrap();
        let cfg = parse(&out);
        assert_eq!(cfg.events().key.as_deref(), Some(PK));
        assert!(out.contains("events:"));
    }

    #[test]
    fn canonical_block_leaves_build_tail_byte_identical() {
        let input = config_with(
            "events:\n  mode: cloud\n  url: https://cloud.dif.sh\n",
            true,
        );
        let out = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        // Everything from `build:` on is unchanged.
        let tail_in = &input[input.find("build:").unwrap()..];
        let tail_out = &out[out.find("build:").unwrap()..];
        assert_eq!(tail_in, tail_out);
        assert_eq!(parse(&out).events().key.as_deref(), Some(PK));
    }

    #[test]
    fn block_at_eof_without_trailing_newline() {
        let input = "project: demo\ndefault_surface: home\nbucketing:\n  id: user_id\n  fallback: anon_cookie\nevents:\n  mode: cloud";
        assert!(!input.ends_with('\n'));
        let out = upsert_events_block(input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert!(!out.contains("cloudkey"), "must not concatenate mode + key");
        assert!(!out.ends_with('\n'), "preserve missing trailing newline");
        let cfg = parse(&out);
        assert_eq!(cfg.events().mode, EventsMode::Cloud);
        assert_eq!(cfg.events().key.as_deref(), Some(PK));
    }

    #[test]
    fn crlf_file_stays_crlf() {
        let input = "project: demo\r\ndefault_surface: home\r\nbucketing:\r\n  id: user_id\r\n  fallback: anon_cookie\r\nevents:\r\n  mode: cloud\r\n";
        let out = upsert_events_block(input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert!(
            out.contains(&format!("  key: {PK}\r\n")),
            "appended line is CRLF"
        );
        // No lone LF: every '\n' must be preceded by '\r'.
        let bytes = out.as_bytes();
        let lone_lf = bytes
            .iter()
            .enumerate()
            .any(|(i, &b)| b == b'\n' && (i == 0 || bytes[i - 1] != b'\r'));
        assert!(!lone_lf, "output must stay pure CRLF");
        assert_eq!(parse(&out).events().key.as_deref(), Some(PK));
    }

    #[test]
    fn four_space_indent_is_matched() {
        let input = config_with("events:\n    mode: cloud\n", true);
        let out = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert!(
            out.contains(&format!("    key: {PK}")),
            "appended key copies 4-space indent"
        );
        assert_eq!(parse(&out).events().key.as_deref(), Some(PK));
    }

    #[test]
    fn existing_key_is_rotated_idempotently() {
        let input = config_with("events:\n  mode: cloud\n  key: dif_pk_live_old\n", true);
        let once = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert_eq!(once.matches("key:").count(), 1, "exactly one key line");
        assert!(once.contains(&format!("key: {PK}")));
        assert!(!once.contains("dif_pk_live_old"));
        let twice = upsert_events_block(&once, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert_eq!(once, twice, "second run is a no-op");
    }

    #[test]
    fn custom_mode_flips_to_cloud() {
        let input = config_with("events:\n  mode: custom\n", true);
        let out = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert!(out.contains("mode: cloud"));
        assert!(!out.contains("mode: custom"));
        assert_eq!(parse(&out).events().mode, EventsMode::Cloud);
    }

    #[test]
    fn flip_refreshes_dif_leading_comment() {
        // dif's own custom comment sits above the block; flipping to cloud must
        // rewrite it so it no longer describes custom handlers.
        let custom_block = render_events_block(EventsMode::Custom, None, None);
        let input = config_with(&format!("{custom_block}\n"), true);
        assert!(input.contains("you export from"));
        let out = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert!(
            !out.contains("you export from"),
            "stale custom comment must be gone"
        );
        assert!(
            out.contains("posts exposures and dif.track()"),
            "cloud comment written"
        );
        assert_eq!(parse(&out).events().key.as_deref(), Some(PK));
    }

    #[test]
    fn rotation_leaves_user_comment_untouched() {
        // Not a flip (cloud → cloud) and a user's own comment — must be preserved.
        let input = config_with("# my own note about events\nevents:\n  mode: cloud\n", true);
        let out = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert!(out.contains("# my own note about events"));
    }

    #[test]
    fn flip_leaves_non_dif_comment_untouched() {
        // A flip, but the comment above is the user's — we don't rewrite it.
        let input = config_with(
            "# hand-written, keep verbatim\nevents:\n  mode: custom\n",
            true,
        );
        let out = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert!(out.contains("# hand-written, keep verbatim"));
        assert_eq!(parse(&out).events().mode, EventsMode::Cloud);
    }

    #[test]
    fn absent_mode_is_inserted() {
        let input = config_with("events:\n  url: https://cloud.dif.sh\n", true);
        let out = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert!(out.contains("mode: cloud"));
        assert_eq!(parse(&out).events().mode, EventsMode::Cloud);
    }

    #[test]
    fn interleaved_comment_is_preserved() {
        let input = config_with(
            "events:\n  mode: cloud\n  # keep me\n  url: https://cloud.dif.sh\n",
            true,
        );
        let out = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert!(out.contains("# keep me"), "interleaved comment survives");
        assert_eq!(parse(&out).events().key.as_deref(), Some(PK));
    }

    #[test]
    fn decoy_events_in_comment_is_ignored() {
        let input = "project: demo\ndefault_surface: home\n# events: not the real one\nbucketing:\n  id: user_id\n  fallback: anon_cookie\nevents:\n  mode: cloud\n";
        let out = upsert_events_block(input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert!(
            out.contains("# events: not the real one"),
            "decoy comment untouched"
        );
        assert_eq!(parse(&out).events().key.as_deref(), Some(PK));
    }

    #[test]
    fn other_sections_are_unchanged() {
        let input = config_with("events:\n  mode: cloud\n", true);
        let out = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        let before = parse(&input);
        let after = parse(&out);
        assert_eq!(before.project, after.project);
        assert_eq!(before.default_surface, after.default_surface);
        assert_eq!(before.bucketing.id, after.bucketing.id);
        assert_eq!(before.build.out, after.build.out);
    }

    #[test]
    fn url_is_updated_when_provided() {
        let input = config_with(
            "events:\n  mode: cloud\n  url: https://old.example.com\n",
            true,
        );
        let out = upsert_events_block(&input, EventsMode::Cloud, Some(URL), Some(PK)).unwrap();
        assert_eq!(parse(&out).events().url.as_deref(), Some(URL));
    }

    #[test]
    fn url_untouched_when_none() {
        let input = config_with("events:\n  mode: cloud\n  url: https://self.hosted\n", true);
        let out = upsert_events_block(&input, EventsMode::Cloud, None, Some(PK)).unwrap();
        assert_eq!(
            parse(&out).events().url.as_deref(),
            Some("https://self.hosted")
        );
    }

    #[test]
    fn malformed_events_returns_err() {
        // `events:` as a list item is not a mapping — splicing children under it
        // yields invalid YAML; the verify pass must reject it.
        let input = "project: demo\ndefault_surface: home\nbucketing:\n  id: user_id\n  fallback: anon_cookie\nevents:\n- oops\n";
        let result = upsert_events_block(input, EventsMode::Cloud, None, Some(PK));
        assert!(result.is_err());
    }
}
