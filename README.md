# ESP-IDF Web Release Bundle Action

This repository is a reusable GitHub Action. It does not build your firmware, upload release assets, or publish GitHub Pages for you.

It packages an existing ESP-IDF `build/` output into:

- a standalone release manifest ready to upload to a GitHub release
- a CLI bundle zip containing the firmware payload and helper files
- a `release-notes-snippet.md` file with a web-installer link and `esptool` fallback command
- a static `esptool-js` web installer directory that you can publish to GitHub Pages

## What The Action Expects

Run the action after your ESP-IDF project has already been built. It reads `flasher_args.json` and the referenced `.bin` files from the configured build directory.

## Inputs

- `release-tag`: required release tag such as `v1.2.3`
- `project-path`: ESP-IDF project path in the caller repository. Default: `.`
- `build-directory`: build directory relative to `project-path`. Default: `build`
- `repository`: optional `owner/name`, used for release links in the generated metadata
- `pages-base-url`: optional public installer base URL such as `https://owner.github.io/repo/`
- `pages-input-dir`: optional existing Pages checkout to merge old releases into the new output
- `pages-output-dir`: output directory for the merged Pages site. Default: `dist/pages`
- `release-assets-dir`: output directory for standalone release assets. Default: `dist/release-assets`
- `release-bundle-dir`: output directory for files that will be packed into the CLI zip. Default: `dist/release-bundle`
- `manifest-asset-name`: release asset name for the web installer manifest. Default: `web-installer-manifest.json`
- `site-title`, `site-description`, `default-baud-rate`: installer page settings

## Outputs

- `release-assets-dir`
- `release-bundle-dir`
- `pages-dir`
- `release-snippet-file`
- `cli-bundle-file`
- `manifest-file`

## Example Workflow

This example is intentionally complete: it builds an ESP-IDF project, packages the outputs with this action, uploads the assets to the GitHub release, updates the release body, and publishes the installer site.

```yaml
name: Release Firmware

on:
  release:
    types: [published]

permissions:
  contents: write
  pages: write
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    env:
      RELEASE_TAG: ${{ github.event.release.tag_name }}
      PAGES_URL: https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}/
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Build firmware
        path: firmware
        uses: espressif/esp-idf-ci-action@v1
        with:
          esp_idf_version: v5.5

      - name: Package web installer and release assets
        id: bundle
        uses: josephabbey/esptool-web-releases@v1
        with:
          release-tag: ${{ env.RELEASE_TAG }}
          project-path: firmware
          build-directory: build
          repository: ${{ github.repository }}
          pages-base-url: ${{ env.PAGES_URL }}
          pages-output-dir: dist/pages
          release-assets-dir: dist/release-assets
          release-bundle-dir: dist/release-bundle
          site-title: My Device Installer
          site-description: Install released firmware in Chrome or Edge.

      - name: Upload release assets
        uses: softprops/action-gh-release@v2
        with:
          tag_name: ${{ env.RELEASE_TAG }}
          overwrite_files: true
          files: |
            ${{ steps.bundle.outputs.manifest-file }}
            ${{ steps.bundle.outputs.cli-bundle-file }}

      - name: Update release body
        uses: actions/github-script@v7
        env:
          SNIPPET_FILE: ${{ steps.bundle.outputs.release-snippet-file }}
        with:
          script: |
            const fs = require("node:fs");
            const snippet = fs.readFileSync(process.env.SNIPPET_FILE, "utf8");
            const start = "<!-- firmware-web-installer:start -->";
            const end = "<!-- firmware-web-installer:end -->";
            const release = context.payload.release;
            const pattern = new RegExp(`${start}[\\s\\S]*?${end}\\n?`, "m");
            const body = release.body || "";
            const nextBody = pattern.test(body)
              ? body.replace(pattern, snippet.trimEnd())
              : `${body.trimEnd()}\n\n${snippet.trimEnd()}\n`.trim();
            await github.rest.repos.updateRelease({
              owner: context.repo.owner,
              repo: context.repo.repo,
              release_id: release.id,
              body: nextBody,
            });

      - name: Configure GitHub Pages
        uses: actions/configure-pages@v5

      - name: Upload GitHub Pages artifact
        uses: actions/upload-pages-artifact@v4
        with:
          path: ${{ steps.bundle.outputs.pages-dir }}

  deploy-pages:
    runs-on: ubuntu-latest
    needs: publish
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Deploy to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@v4
```

## Notes

- The example above uses the current official GitHub Pages Actions flow: `actions/configure-pages@v5`, `actions/upload-pages-artifact@v4`, and `actions/deploy-pages@v4`.
- If you want the installer page to keep older releases, pass a reusable source snapshot with `pages-input-dir`. In the example, that snapshot is stored in a `pages-source` branch.
- If you leave `pages-base-url` empty, the release snippet is still generated, but it cannot include a direct installer URL.
- The installer UI in this action uses `esptool-js` and expects a Chromium-based browser for Web Serial support.
