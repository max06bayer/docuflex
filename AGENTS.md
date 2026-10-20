# Notes for agents working on Docuflex

- **Releases:** follow [RELEASING.md](RELEASING.md). Windows, Linux and Arch are built
  by GitHub Actions and attached to a draft release by the workflow when a `v*`
  tag is pushed. Only the macOS DMG is built on a Mac and uploaded. Never download
  CI artifacts just to re-upload them.
- **`main` is protected** and deploys the website (docuflex.eu, via Coolify). Work
  on a branch, open a PR, and merge only when the user asks.
- **Dark mode** is generated: after changing light styles, run
  `node scripts/generate-dark-theme.mjs`. Hand-tuned dark rules go in each
  component's `/* dark theme: manual */` block, never in the generated block.
- **Desktop vs. website:** the desktop shell sets `html[data-docuflex-desktop]`.
  Website-only layout uses `.editor-shell.website`. AI chat on the website uses
  the visitor's own key, kept in their browser (`src/lib/ai-web.js`); MCP and the
  key file stay desktop/local only.
