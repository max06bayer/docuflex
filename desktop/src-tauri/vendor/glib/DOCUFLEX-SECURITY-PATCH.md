# GLib 0.18 security backport

This is the unmodified crates.io glib 0.18.5 source except for the two-line
upstream fix to `VariantStrIter::impl_get` in `src/variant_iter.rs`.
It passes the C out-pointer as a mutable reference, fixing
RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g.

Upstream fix: https://github.com/gtk-rs/gtk-rs-core/pull/1343
Upstream merge: 05dff0ee696f9bcd8617cd48c4b812d046d440cb
Advisory: https://rustsec.org/advisories/RUSTSEC-2024-0429.html

GTK3/Tauri 2 requires the glib 0.18 API. Updating it independently to glib
0.20 would break GTK's public types. This backport preserves that API and
contains the upstream security fix. The original MIT license is retained.

Verify with optimized upstream iterator regression tests:
`cargo test --manifest-path desktop/src-tauri/vendor/glib/Cargo.toml --lib --release variant_iter`

Remove this patch when the supported GTK3/Tauri dependency stack provides
a compatible upstream release containing the fix.
