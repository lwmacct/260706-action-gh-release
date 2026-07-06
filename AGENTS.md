# AGENTS.md

## Project Constraints

- Keep the current Rollup-based packaging approach.
- Do not replace the build pipeline with ncc, esbuild, webpack, or another bundler.
- Preserve the chunked `dist/` output style because stable, low-noise build diffs are a project goal.
