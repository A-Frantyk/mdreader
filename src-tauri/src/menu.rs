//! The app's native menu bar. Hand-built rather than `tauri::menu::Menu::default()`,
//! for two reasons verified against the `tauri`/`muda` crate sources:
//!
//! - `Menu::default()`'s File submenu is `#[cfg(not(any(target_os = "linux",
//!   target_os = "dragonfly", target_os = "freebsd", target_os = "netbsd",
//!   target_os = "openbsd")))]` — there is no File submenu on Linux at all.
//!   This app needs New/Open/Save on every desktop platform.
//! - `Menu::default()`'s File and Window submenus both carry
//!   `PredefinedMenuItem::close_window`, which `muda` gives the Cmd+W
//!   accelerator on macOS. AppKit resolves menu key equivalents before the
//!   webview ever sees the keystroke, so that item would hijack this app's
//!   own Cmd+W "close the active tab" behavior (wired in `app.js`'s global
//!   keydown handler) and close the whole window instead. `close_window` is
//!   deliberately omitted from every submenu below — don't add it back.
//!
//! Quit is a **custom** menu item, not `PredefinedMenuItem::quit`. Traced
//! through the crate sources: `muda`'s macOS predefined Quit sends
//! `terminate:` to `NSApp`; `tao`'s `NSApplicationDelegate` implements only
//! `applicationWillTerminate`, never `applicationShouldTerminate`, so there
//! is no veto point; `tauri-runtime-wry` produces `RunEvent::ExitRequested`
//! from exactly two places (a window-destroyed event, and
//! `AppHandle::exit`/`restart`) — neither reachable from `terminate:`. So
//! the predefined item would terminate the process with no interceptable
//! event at all, bypassing the unsaved-changes quit sequence entirely. A
//! custom item routes through `handle` below like every other menu action,
//! into the same `menu-action` event the frontend already listens for.
//! (Secondary reasons: the predefined item's accelerator is macOS-only, and
//! GTK's `muda` backend drops the predefined Quit item outright.)

#[cfg(not(target_os = "macos"))]
use tauri::menu::HELP_SUBMENU_ID;
#[cfg(target_os = "macos")]
use tauri::menu::WINDOW_SUBMENU_ID;
use tauri::menu::{AboutMetadata, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

pub const NEW: &str = "new";
pub const OPEN: &str = "open";
pub const SAVE: &str = "save";
pub const QUIT: &str = "quit";

pub fn build<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = handle.package_info();
    let config = handle.config();
    let about_metadata = AboutMetadata {
        name: Some(pkg_info.name.clone()),
        version: Some(pkg_info.version.to_string()),
        copyright: config.bundle.copyright.clone(),
        authors: config.bundle.publisher.clone().map(|p| vec![p]),
        ..Default::default()
    };

    // Custom quit item, present in the macOS App submenu and (with its own
    // separator) at the bottom of File elsewhere — see the module doc for
    // why this can't be `PredefinedMenuItem::quit`.
    let quit = MenuItem::with_id(handle, QUIT, "Quit mdreader", true, Some("CmdOrCtrl+Q"))?;

    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[
            &MenuItem::with_id(handle, NEW, "New", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(handle, OPEN, "Open…", true, Some("CmdOrCtrl+O"))?,
            &PredefinedMenuItem::separator(handle)?,
            &MenuItem::with_id(handle, SAVE, "Save", true, Some("CmdOrCtrl+S"))?,
            #[cfg(not(target_os = "macos"))]
            &PredefinedMenuItem::separator(handle)?,
            #[cfg(not(target_os = "macos"))]
            &quit,
        ],
    )?;

    // Undo/redo/clipboard are the real behavior CodeMirror needs from an
    // Edit menu; reproduced by hand here because a custom app-wide menu
    // replaces Tauri's auto-installed macOS default wholesale, not just
    // supplements it — losing these would break Copy/Paste/Undo/Select-All
    // inside the editor.
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;

    // Window submenu carries only Minimize (no close_window, see the
    // module doc). macOS-only: on Linux muda drops unsupported predefined
    // items (including Minimize) silently, which would otherwise render as
    // an empty "Window" menu.
    #[cfg(target_os = "macos")]
    let window_menu = Submenu::with_id_and_items(
        handle,
        WINDOW_SUBMENU_ID,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(handle, None)?],
    )?;

    #[cfg(not(target_os = "macos"))]
    let help_menu = Submenu::with_id_and_items(
        handle,
        HELP_SUBMENU_ID,
        "Help",
        true,
        &[&PredefinedMenuItem::about(handle, None, Some(about_metadata.clone()))?],
    )?;

    Menu::with_items(
        handle,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                handle,
                pkg_info.name.clone(),
                true,
                &[
                    &PredefinedMenuItem::about(handle, None, Some(about_metadata))?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::services(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &PredefinedMenuItem::hide(handle, None)?,
                    &PredefinedMenuItem::hide_others(handle, None)?,
                    &PredefinedMenuItem::separator(handle)?,
                    &quit,
                ],
            )?,
            &file_menu,
            &edit_menu,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(handle, "View", true, &[&PredefinedMenuItem::fullscreen(handle, None)?])?,
            #[cfg(target_os = "macos")]
            &window_menu,
            #[cfg(not(target_os = "macos"))]
            &help_menu,
        ],
    )
}

/// Forwards a menu click to the frontend as a plain string id, alongside
/// the existing `files-pending` event — `app.js` dispatches on it the same
/// way it already dispatches on that one.
pub fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let _ = app.emit("menu-action", event.id().0.clone());
}
