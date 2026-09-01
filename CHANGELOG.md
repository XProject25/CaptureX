# Changelog

## 1.0.0

Initial release.

- Full-page capture by scroll and stitch, plus a visible-area-only mode.
- Download as JPG (with quality slider) or PNG.
- Fixed and sticky elements are captured once at the top instead of repeating.
- Output rendered at the device pixel ratio; oversized pages are scaled to fit the canvas limit.
- Rate-limited `captureVisibleTab` calls so Chrome never rejects a frame.
- Minimal permissions: `activeTab` and `scripting` only.
