// Cross-platform "is the primary mouse button currently held" query, used by the Phase 5 tab
// drag poll loop (drag.rs) alongside Tauri's own `cursor_position()` for the position half.
//
// Deliberately a plain OS *state query* on each platform, not a global input hook/tap (like the
// `device_query` crate, which bundles keyboard+mouse hooking behind one API) — state queries
// don't require the macOS Accessibility permission that a global event tap does, which matters
// a lot for a dev workflow where an unsigned debug build re-triggers that prompt on every
// rebuild. See docs/... Phase 5 plan, Milestone 0.
//
// Verified by compiling on this machine: only the macOS path. The Windows path is written
// against the well-established `windows-rs` binding conventions but has not been compiled or
// run on Windows. Linux is not yet implemented (see below) — flag both to a human before
// shipping cross-platform.

#[cfg(target_os = "macos")]
mod imp {
    // CGEventSourceButtonState is a small, public, documented Core Graphics function
    // (ApplicationServices/CoreGraphics — ships on every macOS install). The `core-graphics`
    // crate's Rust bindings don't wrap this specific query, so it's called directly via FFI
    // rather than pulling in a crate for one function.
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGEventSourceButtonState(state_id: i32, button: u32) -> u8;
    }

    const K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE: i32 = 0;
    const K_CG_MOUSE_BUTTON_LEFT: u32 = 0;

    pub fn left_button_down() -> bool {
        unsafe { CGEventSourceButtonState(K_CG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE, K_CG_MOUSE_BUTTON_LEFT) != 0 }
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};

    pub fn left_button_down() -> bool {
        // High bit set means the key/button is currently down. A state query, not a hook —
        // doesn't require any special Windows permission.
        (unsafe { GetAsyncKeyState(VK_LBUTTON.0 as i32) } as u16 & 0x8000) != 0
    }
}

// Linux: not yet implemented. X11 (`XQueryPointer`) could support this; native Wayland
// fundamentally can't (no portal exposes global button state, by the compositor's own security
// model — no crate/library choice avoids that). Rather than ship untested low-level X11 FFI
// with no way to verify it on this machine, tab tear-off is disabled on Linux for now (button
// always reads "not held", which the drag poll loop treats as an immediate/no-op release).
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    pub fn left_button_down() -> bool {
        false
    }
}

pub use imp::left_button_down;
