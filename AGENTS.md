# Slate workflow

After making application changes, validate them, rebuild the macOS app, update
`/Applications/Slate.app`, and reopen the installed app. The user has requested
this as the default workflow; do not stop after updating only the source or web
build.

- Run the checks relevant to the changes before installing.
- Build the production assets with `pnpm build`, then package the local app with
  `pnpm exec electron-builder --mac --arm64 --dir --publish never`.
- Quit the running app normally. Preserve unsaved work; never force-quit or
  discard edits to complete an update.
- Preserve the previous app as a temporary backup, install the new bundle, and
  verify its signature and successful launch with the user's workspace restored.
- Documentation-only changes do not require rebuilding the app.
