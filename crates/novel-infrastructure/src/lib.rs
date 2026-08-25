//! Adapters for persistence, files, model providers, and operating-system APIs.

/// Returns the ordered layers linked into the infrastructure boundary.
#[must_use]
pub fn linked_layers() -> [&'static str; 3] {
    let [domain, application] = novel_application::linked_layers();
    [domain, application, "infrastructure"]
}

#[cfg(test)]
mod tests {
    #[test]
    fn infrastructure_depends_inward() {
        assert_eq!(
            super::linked_layers(),
            ["domain", "application", "infrastructure"]
        );
    }
}
