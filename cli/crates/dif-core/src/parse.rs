//! Frontmatter + body parsing for `.md` experiment and surface files.
//!
//! The parser must preserve byte spans so diagnostics in [`crate::diag`] can
//! render `rustc`-style underlines pointing at the exact YAML key that broke,
//! and so `dif conclude` can rewrite the `## Decision` block without touching
//! the rest of the file.

use crate::spec::{Experiment, Learning, Surface};
use chrono::NaiveDate;
use std::fs;
use std::path::{Path, PathBuf};
use thiserror::Error;

/// What you get back from parsing one experiment file.
#[derive(Debug, Clone)]
pub struct ParsedExperiment {
    /// Decoded frontmatter.
    pub spec: Experiment,
    /// The full source text. Kept for diagnostics + the conclude flow, which
    /// needs to write back to specific spans.
    pub source: String,
    /// Byte offset where the body (post-closing-`---`) starts. Section parsing
    /// keys off this.
    pub body_offset: usize,
    /// Filesystem path the experiment was loaded from. Empty for in-memory
    /// parses via [`parse_experiment_str`]; set by [`parse_experiment`].
    pub path: PathBuf,
}

/// What you get back from parsing one surface file.
#[derive(Debug, Clone)]
pub struct ParsedSurface {
    /// Decoded surface.
    pub surface: Surface,
    /// Full source text. Kept for diagnostics + so `dif conclude` can write
    /// back to the `## Learnings` block.
    pub source: String,
    /// Filesystem path the surface was loaded from. Empty for in-memory parses.
    pub path: PathBuf,
}

/// Sectioned body — used by `dif conclude` to swap in the `## Decision` block
/// without disturbing the rest of the file.
#[derive(Debug, Clone, Default)]
pub struct Body {
    /// `## Brief` block, if present.
    pub brief: Option<Section>,
    /// `## Rationale` block, if present.
    pub rationale: Option<Section>,
    /// `## Decision` block, if present (typically empty until conclude runs).
    pub decision: Option<Section>,
}

/// One markdown section, located by byte range.
#[derive(Debug, Clone)]
pub struct Section {
    /// Inclusive start byte (where the `##` heading begins).
    pub start: usize,
    /// Exclusive end byte (next heading or EOF).
    pub end: usize,
    /// The section body, without the heading line. Trimmed.
    pub content: String,
}

/// Anything that can go wrong while parsing a `.md` file.
#[derive(Debug, Error)]
pub enum ParseError {
    /// File missing or unreadable.
    #[error("io error reading {path}: {source}")]
    Io {
        /// Path we tried to read.
        path: String,
        /// Underlying IO failure.
        #[source]
        source: std::io::Error,
    },
    /// Frontmatter delimiters not found.
    #[error("file has no `---` frontmatter delimiters")]
    MissingFrontmatter,
    /// YAML failed to parse.
    #[error("invalid yaml in frontmatter: {0}")]
    Yaml(#[from] serde_yaml::Error),
    /// Surface file is missing its `# Surface: <name>` heading.
    #[error("surface file has no `# ` heading")]
    MissingSurfaceHeading,
}

// -- experiment parsing --------------------------------------------------------

/// Parse an experiment file at `path`. Reads the file and decodes frontmatter
/// + body sections.
pub fn parse_experiment(path: &Path) -> Result<ParsedExperiment, ParseError> {
    let source = fs::read_to_string(path).map_err(|source| ParseError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let mut parsed = parse_experiment_str(&source)?;
    parsed.path = path.to_path_buf();
    Ok(parsed)
}

/// Parse an experiment from an in-memory source string. The IO-free entrypoint
/// that all tests run through. `path` is left empty; the file-based wrapper
/// populates it.
pub fn parse_experiment_str(source: &str) -> Result<ParsedExperiment, ParseError> {
    let (yaml, body_offset) = split_frontmatter(source)?;
    let spec: Experiment = serde_yaml::from_str(yaml)?;
    Ok(ParsedExperiment {
        spec,
        source: source.to_string(),
        body_offset,
        path: PathBuf::new(),
    })
}

/// Locate the YAML frontmatter and return `(yaml_slice, body_byte_offset)`.
///
/// The frontmatter must be the first thing in the file — starting at byte 0
/// with `---\n` (or `---\r\n`) and closed by a `---` line.
fn split_frontmatter(source: &str) -> Result<(&str, usize), ParseError> {
    let body_after_open = if let Some(s) = source.strip_prefix("---\n") {
        source.len() - s.len()
    } else if let Some(s) = source.strip_prefix("---\r\n") {
        source.len() - s.len()
    } else {
        return Err(ParseError::MissingFrontmatter);
    };

    let bytes = source.as_bytes();
    let mut pos = body_after_open;
    while pos <= source.len() {
        let line_end = bytes
            .get(pos..)
            .and_then(|s| s.iter().position(|&b| b == b'\n'))
            .map(|i| pos + i)
            .unwrap_or(source.len());

        let line = &source[pos..line_end];
        let trimmed = line.trim_end_matches('\r');

        if trimmed == "---" {
            let yaml = &source[body_after_open..pos];
            let body_start = if line_end < source.len() {
                line_end + 1
            } else {
                line_end
            };
            return Ok((yaml, body_start));
        }

        if line_end >= source.len() {
            break;
        }
        pos = line_end + 1;
    }

    Err(ParseError::MissingFrontmatter)
}

// -- body section parsing ------------------------------------------------------

/// Pull a sectioned `Body` out of an already-loaded experiment file. Cheap;
/// indexes byte ranges, allocates only the section content strings.
pub fn parse_body(source: &str, body_offset: usize) -> Body {
    let mut body = Body::default();
    let mut current: Option<(String, usize)> = None;

    let bytes = source.as_bytes();
    let mut pos = body_offset;
    while pos <= source.len() {
        let line_end = bytes
            .get(pos..)
            .and_then(|s| s.iter().position(|&b| b == b'\n'))
            .map(|i| pos + i)
            .unwrap_or(source.len());

        let line = &source[pos..line_end];
        let trimmed = line.trim_end_matches('\r');

        if let Some(heading) = trimmed.strip_prefix("## ") {
            if let Some((name, start)) = current.take() {
                assign_section(&mut body, &name, build_section(source, start, pos));
            }
            current = Some((heading.trim().to_string(), pos));
        }

        if line_end >= source.len() {
            break;
        }
        pos = line_end + 1;
    }

    if let Some((name, start)) = current.take() {
        assign_section(&mut body, &name, build_section(source, start, source.len()));
    }

    body
}

fn build_section(source: &str, start: usize, end: usize) -> Section {
    // Skip past the heading line so `content` is only the body.
    let bytes = source.as_bytes();
    let heading_end = bytes[start..end]
        .iter()
        .position(|&b| b == b'\n')
        .map(|i| start + i + 1)
        .unwrap_or(end);
    let content = source
        .get(heading_end..end)
        .unwrap_or("")
        .trim()
        .to_string();
    Section {
        start,
        end,
        content,
    }
}

fn assign_section(body: &mut Body, name: &str, section: Section) {
    match name {
        "Brief" => body.brief = Some(section),
        "Rationale" => body.rationale = Some(section),
        "Decision" => body.decision = Some(section),
        // Unknown sections (e.g. customer-added notes) are preserved in the
        // source text but not surfaced here. `dif conclude` only writes the
        // three above.
        _ => {}
    }
}

// -- surface parsing -----------------------------------------------------------

/// Parse a surface file at `path`. The surface id is derived from the filename
/// stem.
pub fn parse_surface(path: &Path) -> Result<ParsedSurface, ParseError> {
    let source = fs::read_to_string(path).map_err(|source| ParseError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let id = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let surface = parse_surface_str(&source, &id)?;
    Ok(ParsedSurface {
        surface,
        source,
        path: path.to_path_buf(),
    })
}

/// Parse a surface from an in-memory string with an explicit id.
pub fn parse_surface_str(source: &str, id: &str) -> Result<Surface, ParseError> {
    #[derive(Clone, Copy)]
    enum SurfaceSection {
        Header,
        Description,
        Landmines,
        Learnings,
        Other,
    }

    let mut section = SurfaceSection::Header;
    let mut saw_header = false;
    let mut description_lines: Vec<&str> = Vec::new();
    let mut landmines: Vec<String> = Vec::new();
    let mut learnings: Vec<Learning> = Vec::new();
    let mut current_bullet: Option<String> = None;

    let flush = |section: SurfaceSection,
                 bullet: &mut Option<String>,
                 landmines: &mut Vec<String>,
                 learnings: &mut Vec<Learning>| {
        if let Some(text) = bullet.take() {
            match section {
                SurfaceSection::Landmines => landmines.push(text),
                SurfaceSection::Learnings => {
                    if let Some(l) = parse_learning(&text) {
                        learnings.push(l);
                    }
                }
                _ => {}
            }
        }
    };

    for line in source.lines() {
        let trimmed = line.trim_end();

        if let Some(h) = trimmed.strip_prefix("## ") {
            flush(section, &mut current_bullet, &mut landmines, &mut learnings);
            section = match h.trim() {
                "Known landmines" => SurfaceSection::Landmines,
                "Learnings" => SurfaceSection::Learnings,
                _ => SurfaceSection::Other,
            };
            continue;
        }

        // `# ` heading transitions us from Header into Description.
        if !saw_header && trimmed.starts_with("# ") && !trimmed.starts_with("## ") {
            saw_header = true;
            section = SurfaceSection::Description;
            continue;
        }

        match section {
            SurfaceSection::Header => { /* preamble before `# ` — ignore */ }
            SurfaceSection::Description => {
                description_lines.push(line);
            }
            SurfaceSection::Landmines | SurfaceSection::Learnings => {
                if let Some(rest) = line.strip_prefix("- ") {
                    flush(section, &mut current_bullet, &mut landmines, &mut learnings);
                    current_bullet = Some(rest.to_string());
                } else if let Some(rest) = line.strip_prefix("  ") {
                    if let Some(ref mut bullet) = current_bullet {
                        bullet.push(' ');
                        bullet.push_str(rest.trim());
                    }
                } else if line.trim().is_empty() {
                    // Blank lines inside a section are fine; they don't close
                    // the current bullet because authors will hard-wrap.
                }
            }
            SurfaceSection::Other => {}
        }
    }
    flush(section, &mut current_bullet, &mut landmines, &mut learnings);

    if !saw_header {
        return Err(ParseError::MissingSurfaceHeading);
    }

    let description = description_lines.join("\n").trim().to_string();

    Ok(Surface {
        id: id.to_string(),
        description,
        landmines,
        learnings,
    })
}

/// Parse one row of a `## Learnings` block.
///
/// Canonical format (what `dif conclude` writes):
///   `2026-05-28 — checkout-cta-v2: "Get it today" lifted conversion 2.1%.`
///
/// Tolerant on the separator: em-dash `—` (U+2014) preferred, hyphen-minus `-`
/// accepted.
fn parse_learning(text: &str) -> Option<Learning> {
    let text = text.trim();
    if text.len() < 10 {
        return None;
    }
    let date_str = &text[..10];
    let date = NaiveDate::parse_from_str(date_str, "%Y-%m-%d").ok()?;

    let rest = text[10..].trim_start();
    let rest = rest
        .strip_prefix('—')
        .or_else(|| rest.strip_prefix('-'))?
        .trim_start();

    let colon_idx = rest.find(':')?;
    let experiment = rest[..colon_idx].trim().to_string();
    let summary = rest[colon_idx + 1..].trim().to_string();

    if experiment.is_empty() || summary.is_empty() {
        return None;
    }

    Some(Learning {
        date,
        experiment,
        summary,
    })
}

// -- tests --------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spec::Status;

    // NOTE: raw strings (`r#"..."#`) are required for multi-line YAML fixtures.
    // Rust's `\<newline>` continuation escape consumes leading whitespace on
    // the next line, which silently destroys YAML indentation.
    const SAMPLE_EXP: &str = r#"---
id: checkout-cta-v2
status: active
owner: ada@acme.dev
surface: checkout
hypothesis: >
  A more urgent CTA copy on the checkout button will lift
  completed-checkout rate among returning visitors.
audience:
  include:
    - returning_visitor: true
  exclude:
    - country: [US-CA]
variants:
  - id: control
    weight: 50
  - id: variant_a
    weight: 50
    summary: '"Get it today" copy'
metrics:
  primary: completed_checkout
  guardrails: [refund_rate, support_ticket_rate]
exclusion_group: checkout-copy
created: 2026-05-14
---

## Brief

Returning visitors on checkout show a 14% drop-off.

## Rationale

Surface notes flag prior copy tests as inconclusive.

## Decision

<!-- drafted by `dif conclude` -->
"#;

    #[test]
    fn parses_sample_experiment() {
        let parsed = parse_experiment_str(SAMPLE_EXP).expect("parse");
        assert_eq!(parsed.spec.id, "checkout-cta-v2");
        assert_eq!(parsed.spec.status, Status::Active);
        assert_eq!(parsed.spec.owner, "ada@acme.dev");
        assert_eq!(parsed.spec.surface, "checkout");
        assert_eq!(parsed.spec.variants.len(), 2);
        assert_eq!(parsed.spec.variants[0].weight, 50);
        assert_eq!(
            parsed.spec.exclusion_group.as_deref(),
            Some("checkout-copy")
        );
        assert!(parsed.spec.concluded.is_none());
        assert!(parsed.body_offset > 0);
        assert!(parsed.body_offset < SAMPLE_EXP.len());
        // Body offset should land right at the start of the body (post `---\n`).
        assert!(
            SAMPLE_EXP[parsed.body_offset..].starts_with('\n')
                || SAMPLE_EXP[parsed.body_offset..].starts_with("## ")
        );
    }

    #[test]
    fn body_sections_indexed() {
        let parsed = parse_experiment_str(SAMPLE_EXP).expect("parse");
        let body = parse_body(&parsed.source, parsed.body_offset);
        let brief = body.brief.expect("brief");
        let rationale = body.rationale.expect("rationale");
        let decision = body.decision.expect("decision");

        assert!(brief.start < rationale.start);
        assert!(rationale.start < decision.start);
        assert!(brief.content.starts_with("Returning visitors"));
        assert!(rationale.content.starts_with("Surface notes"));
        assert!(decision.content.contains("dif conclude"));
        // Spans cover the heading line through the start of the next.
        assert!(SAMPLE_EXP[brief.start..brief.end].starts_with("## Brief"));
    }

    #[test]
    fn body_missing_sections_are_none() {
        let source = r#"---
id: x
status: active
owner: x@y.com
surface: s
hypothesis: h
variants:
  - id: control
    weight: 100
metrics:
  primary: p
created: 2026-01-01
---

## Brief

foo
"#;
        let parsed = parse_experiment_str(source).expect("parse");
        let body = parse_body(&parsed.source, parsed.body_offset);
        assert!(body.brief.is_some());
        assert!(body.rationale.is_none());
        assert!(body.decision.is_none());
    }

    #[test]
    fn round_trip_serde() {
        let parsed = parse_experiment_str(SAMPLE_EXP).expect("parse");
        let yaml = serde_yaml::to_string(&parsed.spec).expect("serialize");
        let reparsed: Experiment = serde_yaml::from_str(&yaml).expect("re-parse");
        assert_eq!(parsed.spec.id, reparsed.id);
        assert_eq!(parsed.spec.status, reparsed.status);
        assert_eq!(parsed.spec.owner, reparsed.owner);
        assert_eq!(parsed.spec.surface, reparsed.surface);
        assert_eq!(parsed.spec.variants.len(), reparsed.variants.len());
        assert_eq!(parsed.spec.created, reparsed.created);
        assert_eq!(parsed.spec.exclusion_group, reparsed.exclusion_group);
    }

    #[test]
    fn missing_frontmatter_errors() {
        let source = "just some markdown\n## Brief\n";
        let err = parse_experiment_str(source).unwrap_err();
        assert!(matches!(err, ParseError::MissingFrontmatter));
    }

    #[test]
    fn unterminated_frontmatter_errors() {
        let source = "---\nid: x\n";
        let err = parse_experiment_str(source).unwrap_err();
        assert!(matches!(err, ParseError::MissingFrontmatter));
    }

    #[test]
    fn invalid_yaml_errors() {
        let source = "---\nid: x\n  bad: indent\n---\n";
        let err = parse_experiment_str(source).unwrap_err();
        assert!(matches!(err, ParseError::Yaml(_)));
    }

    const SAMPLE_SURFACE: &str = r#"# Surface: checkout

The four screens between cart and confirmation. Single-page
on desktop, three-step on mobile. Traffic skews returning.

## Known landmines

- The address autocomplete is owned by a vendor. Do not
  test inside its DOM. Wrap it.
- US-CA traffic is on legal hold until the privacy audit
  closes. Exclude in every audience block.

## Learnings

- 2026-05-28 — checkout-cta-v2: "Get it today" lifted
  completed-checkout by 2.1% (CI 0.6–3.5%). Shipped.
- 2026-04-11 — trust-badges-row: no effect on
  conversion. Mild positive on support tickets (-4%).
"#;

    #[test]
    fn parses_sample_surface() {
        let s = parse_surface_str(SAMPLE_SURFACE, "checkout").expect("parse");
        assert_eq!(s.id, "checkout");
        assert!(s.description.starts_with("The four screens"));
        assert_eq!(s.landmines.len(), 2);
        assert!(s.landmines[0].contains("address autocomplete"));
        assert!(s.landmines[0].contains("Wrap it."));
        assert_eq!(s.learnings.len(), 2);
        assert_eq!(s.learnings[0].experiment, "checkout-cta-v2");
        assert_eq!(
            s.learnings[0].date,
            NaiveDate::from_ymd_opt(2026, 5, 28).unwrap()
        );
        assert!(s.learnings[0].summary.contains("Get it today"));
        assert_eq!(s.learnings[1].experiment, "trust-badges-row");
    }

    #[test]
    fn surface_missing_h1_errors() {
        let source = "## Learnings\n- 2026-01-01 — x: y\n";
        let err = parse_surface_str(source, "x").unwrap_err();
        assert!(matches!(err, ParseError::MissingSurfaceHeading));
    }

    #[test]
    fn learning_accepts_hyphen_separator() {
        let l = parse_learning("2026-05-28 - exp-id: a summary").expect("parse");
        assert_eq!(l.experiment, "exp-id");
        assert_eq!(l.summary, "a summary");
    }

    #[test]
    fn learning_rejects_bad_date() {
        assert!(parse_learning("not-a-date — exp: x").is_none());
    }
}
