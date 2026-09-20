//! The app's native menu bar, hand-built rather than `tauri::menu::Menu::default()` —
//! see CLAUDE.md's menu invariants for why (`close_window`'s Cmd+W hijack, Quit's
//! `terminate:` bypass). Never add `PredefinedMenuItem::close_window` or `::quit` back.

#[cfg(not(target_os = "macos"))]
use tauri::menu::HELP_SUBMENU_ID;
#[cfg(target_os = "macos")]
use tauri::menu::WINDOW_SUBMENU_ID;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Runtime};

pub const NEW: &str = "new";
pub const OPEN: &str = "open";
pub const SAVE: &str = "save";
pub const QUIT: &str = "quit";
pub const ZOOM_IN: &str = "zoom-in";
pub const ZOOM_OUT: &str = "zoom-out";
pub const ZOOM_RESET: &str = "zoom-reset";
pub const ABOUT: &str = "about";

pub fn build<R: Runtime>(handle: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg_info = handle.package_info();

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

    // A custom menu replaces Tauri's auto-installed macOS default wholesale, not
    // supplements it — omitting these would break Copy/Paste/Undo inside the editor.
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

    // Custom MenuItems, not PredefinedMenuItems, so muda doesn't drop them on Linux like
    // Fullscreen below. "Actual Size" has no accelerator — see CLAUDE.md's zoom invariant.
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

    // macOS-only: on Linux muda silently drops Minimize, which would render an empty menu.
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
        &[&MenuItem::with_id(handle, ABOUT, "About mdreader", true, None::<&str>)?],
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
                    &MenuItem::with_id(handle, ABOUT, "About mdreader", true, None::<&str>)?,
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
