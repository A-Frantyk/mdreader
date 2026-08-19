//! The app's native menu bar. Hand-built rather than `tauri::menu::Menu::default()`,
//! for two reasons verified against the `tauri`/`muda` crate sources:
//!
//! - `Menu::default()`'s File submenu doesn't exist on Linux at all, and
//!   this app needs New/Open/Save on every desktop platform.
//! - `Menu::default()`'s File and Window submenus both carry
//!   `PredefinedMenuItem::close_window`, which `muda` gives the Cmd+W
//!   accelerator on macOS. AppKit resolves menu key equivalents before the
//!   webview ever sees the keystroke, so that item would hijack this app's
//!   own Cmd+W "close the active tab" behavior (wired in `app.js`'s global
//!   keydown handler) and close the whole window instead. `close_window` is
//!   deliberately omitted from every submenu below — don't add it back.
//!
//! Quit is a **custom** menu item, not `PredefinedMenuItem::quit`: muda's
//! macOS predefined Quit sends `terminate:` directly to `NSApp`, which has
//! no interceptable `RunEvent` at all, bypassing the unsaved-changes quit
//! sequence entirely. The custom item instead routes through `handle` below
//! like every other menu action, into the same `menu-action` event the
//! frontend already listens for.

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
pub const ZOOM_IN: &str = "zoom-in";
pub const ZOOM_OUT: &str = "zoom-out";
pub const ZOOM_RESET: &str = "zoom-reset";

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

    // Zoom items are plain custom `MenuItem`s, not `PredefinedMenuItem`s, so
    // — unlike Minimize/Fullscreen/Quit below — muda doesn't silently drop
    // them on Linux; the View menu is therefore built on every platform.
    // Fullscreen is the one item still macOS-only, for that reason.
    // "Actual Size" carries no accelerator: `CmdOrCtrl+0` is already
    // `js/editor-commands.js`'s "clear heading" binding, and a macOS menu
    // key equivalent is resolved by AppKit before the webview ever sees the
    // keystroke, which would silently kill that editor shortcut.
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[
            &MenuItem::with_id(handle, ZOOM_IN, "Zoom In", true, Some("CmdOrCtrl+Equal"))?,
            &MenuItem::with_id(handle, ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+Minus"))?,
            &MenuItem::with_id(handle, ZOOM_RESET, "Actual Size", true, None::<&str>)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::separator(handle)?,
            #[cfg(target_os = "macos")]
            &PredefinedMenuItem::fullscreen(handle, None)?,
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
            &view_menu,
            #[cfg(target_os = "macos")]
            &window_menu,
            #[cfg(not(target_os = "macos"))]
            &help_menu,
        ],
    )
}

pub fn handle<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let _ = app.emit("menu-action", event.id().0.clone());
}
