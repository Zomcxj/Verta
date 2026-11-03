//! The process's one TLS provider.
//!
//! reqwest is built without a bundled provider, so exactly one default has to be installed before a
//! client is built; the updater installs the same `ring` provider. Two callers still build a client
//! of their own - the session-state reader and the version check - and this is the part of the old
//! `net` module they need. Everything else that lived there (the AI request proxy with its address
//! classifier, client cache and stream canceller) had no product consumer and is gone.

use std::sync::OnceLock;

static CRYPTO: OnceLock<()> = OnceLock::new();

pub fn ensure_crypto_provider() {
    CRYPTO.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installing_twice_is_harmless() {
        // Every caller runs this before building a client, and clients are built more than once.
        ensure_crypto_provider();
        ensure_crypto_provider();
    }
}