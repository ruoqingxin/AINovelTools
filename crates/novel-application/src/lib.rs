//! Application use cases and infrastructure ports.

/// Returns the ordered layers currently linked into the application core.
#[must_use]
pub fn linked_layers() -> [&'static str; 2] {
    [novel_domain::layer_name(), "application"]
}

#[cfg(test)]
mod tests {
    #[test]
    fn application_depends_on_domain() {
        assert_eq!(super::linked_layers(), ["domain", "application"]);
    }
}
