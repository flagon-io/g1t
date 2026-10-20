//! The HTTP agents the runner reaches g1t and the internet with.
//!
//! They trust the system's certificates, not webpki-roots: a guarded
//! sandbox re-signs HTTPS with a certificate the runner adds to the system
//! store (guard.rs). ureq's own `native-certs` reads that store with
//! rustls-native-certs 0.7, which parses PEM with the unmaintained
//! rustls-pemfile, so the store is read here with 0.8.

use std::sync::{Arc, LazyLock};

/// The system's certificates, read once, when the first request is made
/// (after guard.rs has added the sandbox's), as ureq's own were.
static TLS: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| {
    let mut roots = rustls::RootCertStore::empty();
    roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
    let config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
        .with_protocol_versions(&[&rustls::version::TLS12, &rustls::version::TLS13])
        .expect("ring supports TLS 1.2 and 1.3")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(config)
});

/// An agent builder that trusts the system's certificates.
pub fn builder() -> ureq::AgentBuilder {
    ureq::AgentBuilder::new().tls_config(TLS.clone())
}

/// A new agent with ureq's defaults, as `ureq::get` and the like make one
/// for each request.
pub fn agent() -> ureq::Agent {
    builder().build()
}
