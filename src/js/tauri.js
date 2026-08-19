// The Tauri JS API surface, read once at load.

// `withGlobalTauri` injects window.__TAURI__ as an initialization script
// that runs before any document script, so it's read synchronously below
// — there is nothing to poll or wait for.
const tauri = window.__TAURI__;
