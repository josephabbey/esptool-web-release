import { ESPLoader, Transport } from "https://unpkg.com/esptool-js@0.6.0/bundle.js";

const state = {
  config: null,
  releases: [],
  manifest: null,
};

const elements = {
  siteTitle: document.querySelector("#site-title"),
  siteDescription: document.querySelector("#site-description"),
  serialWarning: document.querySelector("#serial-warning"),
  statusText: document.querySelector("#status-text"),
  releaseSelect: document.querySelector("#release-select"),
  baudRate: document.querySelector("#baud-rate"),
  connectButton: document.querySelector("#connect-button"),
  releaseLink: document.querySelector("#release-link"),
  cliCommand: document.querySelector("#cli-command"),
  partsTable: document.querySelector("#parts-table"),
  log: document.querySelector("#log"),
};

function appendLog(line) {
  elements.log.textContent += `${line}\n`;
  elements.log.scrollTop = elements.log.scrollHeight;
}

function setStatus(_kind, text) {
  elements.statusText.textContent = text;
}

function terminal() {
  return {
    clean() {
      elements.log.textContent = "";
    },
    writeLine(message) {
      appendLog(message);
    },
    write(message) {
      appendLog(message);
    },
  };
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status}`);
  }
  return response.json();
}

function releaseFromQueryString() {
  const params = new URLSearchParams(window.location.search);
  return params.get("release");
}

function updateReleaseQuery(tag) {
  const url = new URL(window.location.href);
  url.searchParams.set("release", tag);
  window.history.replaceState({}, "", url);
}

function renderReleases() {
  elements.releaseSelect.innerHTML = "";
  for (const release of state.releases) {
    const option = document.createElement("option");
    option.value = release.tag;
    option.textContent = release.prerelease ? `${release.name} (pre-release)` : release.name;
    elements.releaseSelect.append(option);
  }
}

function renderManifest() {
  if (!state.manifest) return;

  elements.releaseLink.href = state.manifest.releaseNotesUrl || "#";
  elements.cliCommand.textContent = state.manifest.cli.command;
  elements.partsTable.innerHTML = "";
  setStatus("Ready", "Release metadata loaded. Connect a board when you are ready to flash.");

  for (const part of state.manifest.parts) {
    const row = document.createElement("tr");
    const offset = document.createElement("td");
    const asset = document.createElement("td");
    offset.textContent = part.offset;
    asset.textContent = part.assetName;
    row.append(offset, asset);
    elements.partsTable.append(row);
  }
}

async function loadManifest(tag) {
  const release = state.releases.find((entry) => entry.tag === tag);
  if (!release) {
    throw new Error(`Unknown release: ${tag}`);
  }

  state.manifest = await fetchJson(release.manifestUrl);
  elements.baudRate.value = state.manifest.baudRate || state.config.defaultBaudRate || 460800;
  renderManifest();
  updateReleaseQuery(tag);
}

async function loadInitialState() {
  state.config = await fetchJson("./site-config.json");
  state.releases = await fetchJson("./releases/index.json");

  elements.serialWarning.hidden = Boolean(navigator.serial);
  elements.siteTitle.textContent = state.config.siteTitle || "ESP Firmware Installer";
  elements.siteDescription.textContent = state.config.siteDescription || "";

  renderReleases();

  const preferredTag = releaseFromQueryString();
  const firstTag = preferredTag && state.releases.some((release) => release.tag === preferredTag)
    ? preferredTag
    : state.releases[0]?.tag;

  if (!firstTag) {
    setStatus("Unavailable", "No published firmware releases were found.");
    appendLog("No published firmware releases were found.");
    elements.connectButton.disabled = true;
    return;
  }

  elements.releaseSelect.value = firstTag;
  await loadManifest(firstTag);
}

async function fetchBinary(relativeUrl) {
  const response = await fetch(relativeUrl);
  if (!response.ok) {
    throw new Error(`Failed to download ${relativeUrl}: ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function connectAndFlash() {
  if (!navigator.serial) {
    setStatus("Unsupported", "This browser does not support Web Serial.");
    elements.serialWarning.hidden = false;
    throw new Error("This browser does not support Web Serial.");
  }
  if (!state.manifest) {
    throw new Error("No release is selected.");
  }

  const files = [];
  for (const part of state.manifest.parts) {
    const data = await fetchBinary(`./releases/${state.manifest.tag}/${part.assetName}`);
    files.push({ data, address: Number.parseInt(part.offset, 16) });
  }

  const port = await navigator.serial.requestPort({});
  const transport = new Transport(port, true);
  const loader = new ESPLoader({
    transport,
    baudrate: Number(elements.baudRate.value),
    terminal: terminal(),
    debugLogging: false,
  });

  try {
    elements.connectButton.disabled = true;
    terminal().clean();
    setStatus("Connecting", `Connecting to ${state.manifest.releaseName || state.manifest.tag}...`);
    appendLog(`Connecting to ${state.manifest.releaseName || state.manifest.tag}...`);
    const chip = await loader.main();
    setStatus("Flashing", `Connected to ${chip}. Flashing firmware now.`);
    appendLog(`Connected to ${chip}. Writing flash...`);
    await loader.writeFlash({
      fileArray: files,
      flashMode: state.manifest.extraEsptoolArgs.flash_mode || "keep",
      flashFreq: state.manifest.extraEsptoolArgs.flash_freq || "keep",
      flashSize: state.manifest.extraEsptoolArgs.flash_size || "keep",
      eraseAll: false,
      compress: true,
      reportProgress(fileIndex, written, total) {
        appendLog(`Part ${fileIndex + 1}: ${written}/${total}`);
      },
    });
    await loader.after(state.manifest.extraEsptoolArgs.after || "hard_reset");
    setStatus("Complete", "Firmware written successfully. The board has been reset.");
    appendLog("Flash complete.");
  } finally {
    try {
      await transport.disconnect();
    } catch (error) {
      appendLog(`Disconnect warning: ${error.message}`);
    }
    elements.connectButton.disabled = false;
  }
}

elements.releaseSelect.addEventListener("change", async (event) => {
  try {
    setStatus("Loading", `Loading ${event.target.value}...`);
    await loadManifest(event.target.value);
  } catch (error) {
    setStatus("Error", error.message);
    appendLog(error.message);
  }
});

elements.connectButton.addEventListener("click", async () => {
  try {
    await connectAndFlash();
  } catch (error) {
    setStatus("Error", error.message);
    appendLog(error.message);
    elements.connectButton.disabled = false;
  }
});

loadInitialState().catch((error) => {
  setStatus("Error", error.message);
  appendLog(error.message);
  elements.connectButton.disabled = true;
});
