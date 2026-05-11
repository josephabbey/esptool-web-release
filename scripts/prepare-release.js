#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) continue;
    const key = current.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = value;
  }
  return args;
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyTree(sourceDir, targetDir) {
  ensureDir(targetDir);
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyTree(sourcePath, targetPath);
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

function sanitizeName(input) {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function numericOffset(value) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") {
    throw new Error(`Unsupported flash offset: ${String(value)}`);
  }
  return value.startsWith("0x") ? Number.parseInt(value, 16) : Number.parseInt(value, 10);
}

function toHexOffset(value) {
  const numeric = numericOffset(value);
  return `0x${numeric.toString(16)}`;
}

function repoPagesUrl(repo) {
  const [owner, name] = repo.split("/");
  if (name === `${owner}.github.io`) {
    return `https://${owner}.github.io/`;
  }
  return `https://${owner}.github.io/${name}/`;
}

function normalizeBaseUrl(input) {
  if (!input) return "";
  return input.endsWith("/") ? input : `${input}/`;
}

function extractFlashFiles(flasherArgs) {
  if (!flasherArgs.flash_files || typeof flasherArgs.flash_files !== "object") {
    throw new Error("Expected flasher_args.json to contain a flash_files object.");
  }

  return Object.entries(flasherArgs.flash_files)
    .map(([offset, filePath]) => ({
      offset: toHexOffset(offset),
      originalPath: filePath,
      numericOffset: numericOffset(offset),
    }))
    .sort((left, right) => left.numericOffset - right.numericOffset);
}

function buildCliCommand(manifest) {
  const extra = manifest.extraEsptoolArgs;
  const pieces = [
    "python -m esptool",
    "--chip",
    "auto",
    "-p",
    "<PORT>",
    "-b",
    String(manifest.baudRate),
  ];

  if (extra.before) {
    pieces.push("--before", extra.before);
  }
  if (extra.after) {
    pieces.push("--after", extra.after);
  }

  pieces.push("write_flash");

  if (extra.flash_mode) {
    pieces.push("--flash_mode", extra.flash_mode);
  }
  if (extra.flash_freq) {
    pieces.push("--flash_freq", extra.flash_freq);
  }
  if (extra.flash_size) {
    pieces.push("--flash_size", extra.flash_size);
  }

  for (const part of manifest.parts) {
    pieces.push(part.offset, part.assetName);
  }

  return pieces.join(" ");
}

function buildReleaseSnippet(manifest) {
  const installerLine = manifest.installUrl
    ? `Install this release in Chrome or Edge: ${manifest.installUrl}`
    : "Install URL not configured. Set pages-base-url in the action input to include a direct installer link here.";

  return [
    "<!-- firmware-web-installer:start -->",
    "## Web Installer",
    "",
    installerLine,
    "",
    "## CLI Fallback",
    "",
    "If you do not have a Chromium-based browser, download and extract `firmware-release-bundle.zip`, then run:",
    "",
    "```bash",
    "python -m pip install esptool",
    manifest.cli.command,
    "```",
    "",
    "Replace `<PORT>` with the serial port for your board.",
    "<!-- firmware-web-installer:end -->",
    "",
  ].join("\n");
}

function copyIfPresent(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) return false;
  fs.copyFileSync(sourcePath, targetPath);
  return true;
}

function loadExistingIndex(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function upsertRelease(index, entry) {
  const filtered = index.filter((current) => current.tag !== entry.tag);
  return [entry, ...filtered];
}

function main() {
  const args = parseArgs(process.argv);
  const projectPath = path.resolve(args.projectPath || ".");
  const buildDirectory = path.resolve(projectPath, args.buildDirectory || "build");
  const outDirectory = path.resolve(args.outDir || "dist/release-assets");
  const bundleDirectory = path.resolve(args.bundleDir || "dist/release-bundle");
  const pagesInputDir = args.pagesInputDir ? path.resolve(args.pagesInputDir) : "";
  const pagesOutDir = path.resolve(args.pagesOutDir || "dist/pages");
  const staticSiteDir = path.resolve(args.staticSiteDir || path.join(__dirname, "..", "web"));
  const releaseTag = args.releaseTag || process.env.RELEASE_TAG;
  const repository = args.repo || process.env.GITHUB_REPOSITORY;
  const pagesBaseUrl = normalizeBaseUrl(args.pagesBaseUrl || "");
  const manifestName = args.manifestAssetName || "web-installer-manifest.json";
  const defaultBaudRate = Number.parseInt(args.defaultBaudRate || "460800", 10);
  const siteTitle = args.siteTitle || "ESP Firmware Installer";
  const siteDescription = args.siteDescription || "Choose a firmware release and flash it from a Chromium-based browser with esptool-js.";
  const releaseSnippetPath = path.resolve(args.releaseSnippetFile || path.join(path.dirname(outDirectory), "release-notes-snippet.md"));

  if (!releaseTag) {
    throw new Error("Missing release tag. Pass --releaseTag or set RELEASE_TAG.");
  }

  const flasherArgsPath = path.join(buildDirectory, "flasher_args.json");
  if (!fs.existsSync(flasherArgsPath)) {
    throw new Error(`Missing ${flasherArgsPath}. Build the project first or point buildDirectory at the right folder.`);
  }

  ensureDir(outDirectory);
  fs.rmSync(bundleDirectory, { recursive: true, force: true });
  ensureDir(bundleDirectory);

  const flasherArgs = loadJson(flasherArgsPath);
  const parts = extractFlashFiles(flasherArgs).map((part) => {
    const sourcePath = path.resolve(buildDirectory, part.originalPath);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Missing firmware binary: ${sourcePath}`);
    }

    const ext = path.extname(part.originalPath) || ".bin";
    const stem = sanitizeName(path.dirname(part.originalPath) === "." ? path.basename(part.originalPath, ext) : part.originalPath.slice(0, -ext.length));
    const assetName = `${part.offset}-${stem}${ext}`;
    fs.copyFileSync(sourcePath, path.join(bundleDirectory, assetName));

    return {
      offset: part.offset,
      originalPath: part.originalPath,
      assetName,
    };
  });

  const manifest = {
    repo: repository,
    tag: releaseTag,
    generatedAt: new Date().toISOString(),
    baudRate: defaultBaudRate,
    installUrl: pagesBaseUrl ? `${pagesBaseUrl}?release=${encodeURIComponent(releaseTag)}` : (repository ? `${repoPagesUrl(repository)}?release=${encodeURIComponent(releaseTag)}` : ""),
    releaseNotesUrl: repository ? `https://github.com/${repository}/releases/tag/${encodeURIComponent(releaseTag)}` : "",
    extraEsptoolArgs: flasherArgs.extra_esptool_args || {},
    parts,
  };

  manifest.cli = {
    bundleName: "firmware-release-bundle.zip",
    command: buildCliCommand(manifest),
  };

  fs.writeFileSync(path.join(outDirectory, manifestName), `${JSON.stringify(manifest, null, 2)}\n`);
  fs.copyFileSync(flasherArgsPath, path.join(bundleDirectory, "flasher_args.json"));

  copyIfPresent(path.join(buildDirectory, "flash_project_args"), path.join(bundleDirectory, "flash_project_args.txt"));
  copyIfPresent(path.join(buildDirectory, "flash_app_args"), path.join(bundleDirectory, "flash_app_args.txt"));

  fs.writeFileSync(releaseSnippetPath, buildReleaseSnippet(manifest));
  fs.writeFileSync(path.join(bundleDirectory, "cli-command.txt"), `${manifest.cli.command}\n`);

  fs.rmSync(pagesOutDir, { recursive: true, force: true });
  if (pagesInputDir && fs.existsSync(pagesInputDir)) {
    copyTree(pagesInputDir, pagesOutDir);
  }
  copyTree(staticSiteDir, pagesOutDir);
  ensureDir(path.join(pagesOutDir, "releases", releaseTag));

  const pageManifest = {
    ...manifest,
    releaseName: releaseTag,
    publishedAt: manifest.generatedAt,
    prerelease: false,
    parts: manifest.parts.map((part) => ({
      ...part,
      url: `./${part.assetName}`,
    })),
  };

  for (const part of manifest.parts) {
    fs.copyFileSync(path.join(bundleDirectory, part.assetName), path.join(pagesOutDir, "releases", releaseTag, part.assetName));
  }

  fs.writeFileSync(path.join(pagesOutDir, "releases", releaseTag, "manifest.json"), `${JSON.stringify(pageManifest, null, 2)}\n`);
  fs.writeFileSync(path.join(pagesOutDir, "site-config.json"), `${JSON.stringify({
    siteTitle,
    siteDescription,
    defaultBaudRate,
  }, null, 2)}\n`);

  const releaseIndexPath = path.join(pagesOutDir, "releases", "index.json");
  const existingIndex = loadExistingIndex(releaseIndexPath);
  const nextIndex = upsertRelease(existingIndex, {
    tag: releaseTag,
    name: releaseTag,
    prerelease: false,
    publishedAt: manifest.generatedAt,
    manifestUrl: `./releases/${releaseTag}/manifest.json`,
    releaseUrl: manifest.releaseNotesUrl,
  });
  fs.writeFileSync(releaseIndexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({ manifestName, partCount: parts.length, bundleDirectory, releaseSnippetPath }, null, 2)}\n`);
}

main();
