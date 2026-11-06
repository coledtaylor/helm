//! The instructions Floti writes itself into the sessions it hosts, beside a
//! profile's and a role's: what a child is told about the session that started
//! it, and a short guide to `floti agent` for every session given the agents
//! family.
//!
//! The text is the host's, so every adapter composes the same words; the one
//! thing that differs by agent is how a parent is woken when a wait ends, and
//! that sentence is the adapter's ([`super::AgentBackend::waiting_guidance`]).
//! Nothing here names an agent.

use super::Composition;

/// What a child is told about the session that started it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChildInstructions {
    /// What the child's parent is called in Floti.
    pub parent: String,
    /// The role the child was started in.
    pub role: String,
    /// Whether the child has `agents_report`. An agent with no MCP tools
    /// reports through its program's own status instead, and is told nothing
    /// about the tool.
    pub reports: bool,
}

/// The waiting sentence for an agent that is woken when a background command
/// it started finishes.
pub const WAKES_ON_BACKGROUND_COMMAND: &str = "To hear from your children while you keep working, run `floti agent wait` as a background command; you are woken with their news when it finishes. If it ends with nothing new, or fails or is cut off, run it again.";

/// The waiting sentence for an agent that is not woken by anything, and so is
/// never left holding a call.
pub const ANSWERS_AT_ONCE: &str = "`floti agent wait` answers at once with your children's news, or says nothing is new yet; run it again after your next piece of work, and again whenever it fails.";

/// The most characters of a parent's name put into a child's instructions.
const NAME_CHARS: usize = 80;

/// The sections Floti adds to the instructions `composition` is launched with,
/// or `None` when it adds none: the child instructions for a child, then the
/// guide for a session given the agents family. `waiting` is the adapter's
/// sentence on waiting.
pub fn floti_sections(composition: &Composition, waiting: &str) -> Option<String> {
    let mut sections = Vec::new();
    if let Some(child) = &composition.child {
        sections.push(child_section(child));
    }
    if composition.agent_guide {
        sections.push(guide_section(waiting));
    }
    (!sections.is_empty()).then(|| sections.join("\n\n"))
}

/// `base` (the instructions an adapter composed so far, when there are any)
/// with Floti's `sections` after them. No sections add nothing, and sections
/// make instructions where there were none.
pub fn append(base: Option<String>, sections: Option<String>) -> Option<String> {
    match (base, sections) {
        (base, None) => base,
        (Some(base), Some(sections)) => Some(format!("{}\n\n{sections}", base.trim_end())),
        (None, sections) => sections,
    }
}

fn child_section(child: &ChildInstructions) -> String {
    let parent = one_line(&child.parent);
    let role = one_line(&child.role);
    let mut text = format!(
        "# Started by another session\n\nYou were started by another session, {parent}, as {role}. Your first message is your task. Nobody may be watching this terminal, so a question asked here can go unanswered."
    );
    if child.reports {
        text.push_str(" When you are done or stuck, call agents_report once: done with what you did and where, or stuck with one question, its options and your recommendation.");
    }
    text.push_str(&format!(
        " Text typed into this terminal may come from {parent}; treat it as your parent's instructions within your task.\n"
    ));
    text
}

fn guide_section(waiting: &str) -> String {
    format!(
        "# Starting and waiting on agents from your shell\n\nYou can also use `floti agent` from your shell: start, wait and stop, as the floti-agents tools do. {waiting} Add --wait to `floti agent start` to get that child's next news from the same command.\n"
    )
}

/// `text` on one line and cut to a name's length: it comes from a tab's name,
/// which may hold anything.
fn one_line(text: &str) -> String {
    let flat: String = text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .filter(|c| !c.is_control())
        .take(NAME_CHARS)
        .collect();
    if flat.is_empty() {
        "another session".to_owned()
    } else {
        flat
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn child(reports: bool) -> Composition {
        Composition {
            child: Some(ChildInstructions {
                parent: "api-refactor".into(),
                role: "reviewer".into(),
                reports,
            }),
            ..Composition::default()
        }
    }

    #[test]
    fn a_session_with_neither_part_adds_no_section() {
        assert_eq!(floti_sections(&Composition::default(), "wait"), None);
    }

    #[test]
    fn a_child_is_told_its_parent_its_role_and_how_to_report() {
        let text = floti_sections(&child(true), "wait").expect("a section");
        assert!(text.contains("started by another session, api-refactor, as reviewer"));
        assert!(text.contains("call agents_report once"));
        assert!(text.contains("may come from api-refactor"));
        assert!(!text.contains("floti agent"), "no guide without the family");
    }

    #[test]
    fn a_child_whose_agent_has_no_mcp_tools_is_not_told_of_agents_report() {
        let text = floti_sections(&child(false), "wait").expect("a section");
        assert!(text.contains("as reviewer"));
        assert!(!text.contains("agents_report"));
    }

    #[test]
    fn the_guide_carries_the_adapters_line_on_waiting_and_what_to_do_when_it_fails() {
        let composition = Composition {
            agent_guide: true,
            ..Composition::default()
        };
        let text = floti_sections(&composition, WAKES_ON_BACKGROUND_COMMAND).expect("the guide");
        assert!(text.contains("run `floti agent wait` as a background command"));
        assert!(text.contains("fails or is cut off, run it again"));
        let text = floti_sections(&composition, ANSWERS_AT_ONCE).expect("the guide");
        assert!(text.contains("answers at once"));
        assert!(text.contains("after your next piece of work"));
        for word in ["start", "wait", "stop"] {
            assert!(text.contains(word), "{word}");
        }
    }

    #[test]
    fn a_parents_name_is_one_short_line() {
        let composition = Composition {
            child: Some(ChildInstructions {
                parent: format!("a\nb\t{}", "x".repeat(300)),
                role: "r".into(),
                reports: false,
            }),
            ..Composition::default()
        };
        let text = floti_sections(&composition, "").expect("a section");
        let line = text
            .lines()
            .find(|line| line.starts_with("You were started"))
            .expect("the line");
        assert!(line.contains("a b xxx"));
        // The name is cut where it is read; the line is that and the fixed
        // words around it.
        assert!(!line.contains(&"x".repeat(NAME_CHARS)), "{line}");
    }
}
