//! Core business rules for novel projects.
//!
//! This crate must remain independent from desktop, persistence, and network
//! frameworks.

/// Returns the stable name used in architecture diagnostics.
#[must_use]
pub const fn layer_name() -> &'static str {
    "domain"
}

#[cfg(test)]
mod tests {
    #[test]
    fn exposes_domain_layer_name() {
        assert_eq!(super::layer_name(), "domain");
    }
}
