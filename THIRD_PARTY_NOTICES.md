# Third-party notices

The application has no runtime package dependencies. The following third-party
assets are vendored into this repository.

## Inter

- SIL Open Font License 1.1
- Copyright (c) 2016 The Inter Project Authors
- Vendored at `public/brand/inter-var.woff2`
- License text at `public/brand/OFL.txt`

## VT323

- SIL Open Font License 1.1
- Copyright 2011 The VT323 Project Authors
- Vendored at `public/brand/vt323.woff2` (copied from the shared jevplay.games brand kit)
- License text at `public/brand/OFL-VT323.txt`

## Art source fonts

- `assets/src/fonts/Inter-Bold.ttf` (SIL Open Font License 1.1, licence text `assets/src/fonts/OFL-Inter.txt`) and
  `assets/src/fonts/VT323-Regular.ttf` (SIL Open Font License 1.1, licence text `assets/src/fonts/OFL-VT323.txt`)
- Copied from the jevplay.games org profile art sources; used only to re-render `assets/banner.png`,
  `assets/social-preview.png` and `public/brand/og.png` from `assets/src/*.html`. Not served by the game.

## @discord/embedded-app-sdk

- MIT License
- Version 2.5.0, Copyright (c) Discord, Inc.
- Vendored bundle at `public/vendor/discord-embedded-app-sdk.js`, loaded only when the game runs as a Discord Activity (see `docs/ACTIVITY.md`)
- Vendored rather than loaded from a CDN because the page's Content-Security-Policy allows scripts from this origin only
