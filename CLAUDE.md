# Schedule Trend

A single-file React app ([index.html](index.html), CDN + Babel, no build step) that tracks
weekly trim/paint/meter schedule PDFs per house and surfaces trend/drift over time.

## Architecture
- **Frontend only lives here.** The backend is a Google Apps Script Web App (Google
  Sheet as the data store) that is not tracked in this repo — see `SCRIPT_URL`/
  `APP_TOKEN` at the top of index.html. If backend changes are needed, ask for the
  Apps Script source to be pasted in (Extensions > Apps Script from the Sheet).
- Stage vocabulary (`STAGE_ORDER`), the duration baseline (`DURATION_BASELINE`), and
  subdivision lookups are hardcoded constants in index.html, not database-driven.

## Design direction
See [DESIGN.md](DESIGN.md) for the long-term visual/UX direction for a future unified
dashboard merging this tool with BuildTrack, PunchTrack, and Scope Deviation (not yet
built — reference only). Keep new component styling loosely consistent with it where
that's low-cost.
