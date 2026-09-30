# Third-party notices

The application has no runtime package dependencies. The following third-party
assets are vendored into this repository.

## Inter

- SIL Open Font License 1.1
- Copyright (c) 2016 The Inter Project Authors
- Vendored at `public/brand/inter-var.woff2`
- License text at `public/brand/OFL.txt`

## @discord/embedded-app-sdk

- MIT License
- Version 2.5.0, Copyright (c) Discord, Inc.
- Vendored bundle at `public/vendor/discord-embedded-app-sdk.js`, loaded only when the game runs as a Discord Activity (see `docs/ACTIVITY.md`)
- Vendored rather than loaded from a CDN because the page's Content-Security-Policy allows scripts from this origin only
