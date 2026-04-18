const state = {
  eegData: null,
  fileName: null,
  selections: [],
  visibleCount: 6,
  viewStart: 0,
  windowSeconds: 10,
  amplitudeScale: 1,
  rowSpacing: 110,
  channelStart: 0,
  dragSelection: null,
  lastEdfFile: null,
};

const canvas = document.getElementById("eeg-canvas");
const context = canvas.getContext("2d");
const jsonInput = document.getElementById("json-input");
const edfInput = document.getElementById("edf-input");
const datasetStatus = document.getElementById("dataset-status");
const backendStatus = document.getElementById("backend-status");
const timeScroll = document.getElementById("time-scroll");
const channelScroll = document.getElementById("channel-scroll");
const visibleCountSelect = document.getElementById("visible-count-select");
const windowSecondsSelect = document.getElementById("window-seconds-select");
const amplitudeScaleSelect = document.getElementById("amplitude-scale-select");
const rowSpacingSelect = document.getElementById("row-spacing-select");
const segmentDurationSelect = document.getElementById("segment-duration-select");
const metadataGrid = document.getElementById("metadata-grid");
const selectionList = document.getElementById("selection-list");
const selectionCount = document.getElementById("selection-count");
const activityLog = document.getElementById("activity-log");
const timeWindowLabel = document.getElementById("time-window-label");
const channelWindowLabel = document.getElementById("channel-window-label");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingMessage = document.getElementById("loading-message");

let loadingTaskCount = 0;

const layout = {
  top: 36,
  right: 28,
  bottom: 34,
  left: 110,
};

function addLog(message) {
  const item = document.createElement("div");
  item.className = "activity-item";
  item.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  activityLog.prepend(item);
  while (activityLog.childElementCount > 8) {
    activityLog.removeChild(activityLog.lastChild);
  }
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function beginLoading(message) {
  loadingTaskCount += 1;
  loadingMessage.textContent = message;
  loadingOverlay.classList.add("active");
  loadingOverlay.setAttribute("aria-hidden", "false");
}

function updateLoadingMessage(message) {
  if (loadingTaskCount > 0) {
    loadingMessage.textContent = message;
  }
}

function endLoading() {
  loadingTaskCount = Math.max(0, loadingTaskCount - 1);
  if (loadingTaskCount === 0) {
    loadingOverlay.classList.remove("active");
    loadingOverlay.setAttribute("aria-hidden", "true");
  }
}

function roundTime(value) {
  return Number(value).toFixed(2);
}

function getChannelNames(data) {
  return data?.channel_names ?? [];
}

function getTimeVector(data) {
  if (!data) {
    return [];
  }
  if (Array.isArray(data.time_vector)) {
    return data.time_vector;
  }
  const samplingRate = Number(data.sampling_rate || 0);
  const channels = Array.isArray(data.channels) ? data.channels : [];
  const firstLength = channels[0]?.y?.length ?? 0;
  if (!samplingRate || !firstLength) {
    return [];
  }
  return Array.from({ length: firstLength }, (_, index) => index / samplingRate);
}

function getChannelData(data, channelName) {
  const channels = Array.isArray(data?.channels) ? data.channels : [];
  return channels.find((channel) => channel.channel_name === channelName)?.y ?? [];
}

function getVisibleChannelNames() {
  if (!state.eegData) {
    return [];
  }
  return getChannelNames(state.eegData).slice(state.channelStart, state.channelStart + state.visibleCount);
}

function getDurationSeconds() {
  return Number(state.eegData?.duration_seconds || 0);
}

function syncControls() {
  const duration = getDurationSeconds();
  const maxTimeStart = Math.max(0, duration - state.windowSeconds);
  timeScroll.max = String(maxTimeStart);
  timeScroll.value = String(Math.min(state.viewStart, maxTimeStart));
  state.viewStart = Number(timeScroll.value);

  const channelCount = getChannelNames(state.eegData).length;
  const maxChannelStart = Math.max(0, channelCount - state.visibleCount);
  channelScroll.max = String(maxChannelStart);
  channelScroll.value = String(Math.min(state.channelStart, maxChannelStart));
  state.channelStart = Number(channelScroll.value);
}

function updateMetadata() {
  const channels = getChannelNames(state.eegData);
  const values = [
    state.fileName || "None",
    String(channels.length),
    `${roundTime(getDurationSeconds())} s`,
    `${Number(state.eegData?.sampling_rate || 0)} Hz`,
    String((state.eegData?.events || []).length),
  ];
  [...metadataGrid.querySelectorAll("dd")].forEach((element, index) => {
    element.textContent = values[index] || "0";
  });
}

function updateSelectionList() {
  selectionCount.textContent = String(state.selections.length);
  selectionList.innerHTML = "";

  if (state.selections.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "No clipping regions selected.";
    selectionList.append(empty);
    return;
  }

  state.selections
    .slice()
    .sort((left, right) => left[0] - right[0])
    .forEach(([start, end], index) => {
      const item = document.createElement("div");
      item.className = "selection-item";

      const label = document.createElement("div");
      label.innerHTML = `<strong>Clip ${index + 1}</strong><span>${roundTime(start)}s - ${roundTime(end)}s</span>`;

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Remove";
      button.addEventListener("click", () => {
        state.selections = state.selections.filter((selection) => selection[0] !== start || selection[1] !== end);
        updateSelectionList();
        render();
      });

      item.append(label, button);
      selectionList.append(item);
    });
}

function setDataset(data, fileName, sourceLabel) {
  state.eegData = data;
  state.fileName = fileName;
  state.selections = [];
  state.channelStart = 0;
  state.viewStart = 0;
  syncControls();
  updateMetadata();
  updateSelectionList();
  datasetStatus.textContent = `${sourceLabel}: ${fileName}`;
  addLog(`Loaded ${fileName} from ${sourceLabel}.`);
  render();
}

function downsampleTrace(times, values, maxPoints) {
  if (times.length <= maxPoints) {
    return { times, values };
  }

  const resultTimes = [];
  const resultValues = [];
  const bucketSize = Math.ceil(times.length / maxPoints);
  for (let index = 0; index < times.length; index += bucketSize) {
    resultTimes.push(times[index]);
    resultValues.push(values[index]);
  }
  return { times: resultTimes, values: resultValues };
}

function getPlotRect() {
  return {
    x: layout.left,
    y: layout.top,
    width: canvas.width - layout.left - layout.right,
    height: canvas.height - layout.top - layout.bottom,
  };
}

function timeToX(time, rect) {
  return rect.x + ((time - state.viewStart) / state.windowSeconds) * rect.width;
}

function xToTime(x, rect) {
  const clamped = Math.max(rect.x, Math.min(rect.x + rect.width, x));
  const fraction = (clamped - rect.x) / rect.width;
  return state.viewStart + fraction * state.windowSeconds;
}

function renderEmptyState() {
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f8fbff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#526072";
  context.font = "24px Bahnschrift, Segoe UI Variable, sans-serif";
  context.fillText("Load a JSON file or open an EDF file to start.", 120, canvas.height / 2);
  timeWindowLabel.textContent = "0.00s - 0.00s";
  channelWindowLabel.textContent = "Channels 0-0";
}

function render() {
  if (!state.eegData) {
    renderEmptyState();
    return;
  }

  syncControls();

  const rect = getPlotRect();
  const allTimes = getTimeVector(state.eegData);
  const windowEnd = Math.min(getDurationSeconds(), state.viewStart + state.windowSeconds);
  const visibleChannels = getVisibleChannelNames();
  const rowHeight = rect.height / Math.max(1, visibleChannels.length);

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#f4f8fc";
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.strokeStyle = "rgba(15, 23, 42, 0.08)";
  context.lineWidth = 1;
  for (let tick = 0; tick <= 10; tick += 1) {
    const x = rect.x + (rect.width * tick) / 10;
    context.beginPath();
    context.moveTo(x, rect.y);
    context.lineTo(x, rect.y + rect.height);
    context.stroke();
  }

  state.selections.forEach(([start, end]) => {
    if (end < state.viewStart || start > windowEnd) {
      return;
    }
    const left = timeToX(Math.max(start, state.viewStart), rect);
    const right = timeToX(Math.min(end, windowEnd), rect);
    context.fillStyle = "rgba(246, 189, 22, 0.24)";
    context.fillRect(left, rect.y, right - left, rect.height);
  });

  const events = Array.isArray(state.eegData.events) ? state.eegData.events : [];
  events.forEach((event) => {
    const time = Number(event.time || 0);
    if (time < state.viewStart || time > windowEnd) {
      return;
    }
    const x = timeToX(time, rect);
    context.strokeStyle = "rgba(191, 63, 50, 0.5)";
    context.beginPath();
    context.moveTo(x, rect.y);
    context.lineTo(x, rect.y + rect.height);
    context.stroke();
  });

  visibleChannels.forEach((channelName, index) => {
    const top = rect.y + rowHeight * index;
    const middle = top + rowHeight / 2;
    const bottom = top + rowHeight;
    const values = getChannelData(state.eegData, channelName);

    const startIndex = allTimes.findIndex((time) => time >= state.viewStart);
    let endIndex = allTimes.findIndex((time) => time > windowEnd);
    const boundedStart = startIndex === -1 ? 0 : startIndex;
    if (endIndex === -1) {
      endIndex = allTimes.length;
    }

    const sliceTimes = allTimes.slice(boundedStart, endIndex);
    const sliceValues = values.slice(boundedStart, endIndex);
    const reduced = downsampleTrace(sliceTimes, sliceValues, Math.max(300, Math.floor(rect.width / 2)));

    // Center each channel around its local mean so low-amplitude changes remain visible.
    const numericValues = reduced.values.map((value) => Number(value) || 0);
    const mean = numericValues.length
      ? numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length
      : 0;
    const centeredValues = numericValues.map((value) => value - mean);

    let maxAbs = 0;
    for (const value of centeredValues) {
      maxAbs = Math.max(maxAbs, Math.abs(value));
    }
    if (maxAbs === 0) {
      maxAbs = 1;
    }

    context.strokeStyle = "rgba(15, 23, 42, 0.10)";
    context.beginPath();
    context.moveTo(rect.x, bottom);
    context.lineTo(rect.x + rect.width, bottom);
    context.stroke();

    context.fillStyle = "#0f172a";
    context.font = "14px Bahnschrift, Segoe UI Variable, sans-serif";
    context.fillText(channelName, 18, middle + 5);

    context.strokeStyle = "#165dff";
    context.lineWidth = 1.2;
    context.beginPath();

    reduced.times.forEach((time, sampleIndex) => {
      const value = centeredValues[sampleIndex] || 0;
      const x = timeToX(time, rect);
      const y = middle - (value / maxAbs) * ((state.rowSpacing / 2.4) * state.amplitudeScale);
      if (sampleIndex === 0) {
        context.moveTo(x, y);
      } else {
        context.lineTo(x, y);
      }
    });

    context.stroke();
  });

  if (state.dragSelection) {
    const left = Math.min(state.dragSelection.startX, state.dragSelection.currentX);
    const width = Math.abs(state.dragSelection.currentX - state.dragSelection.startX);
    context.fillStyle = "rgba(22, 93, 255, 0.18)";
    context.fillRect(left, rect.y, width, rect.height);
  }

  context.fillStyle = "#526072";
  context.font = "13px Bahnschrift, Segoe UI Variable, sans-serif";
  for (let tick = 0; tick <= 10; tick += 1) {
    const time = state.viewStart + (state.windowSeconds * tick) / 10;
    const x = rect.x + (rect.width * tick) / 10;
    context.fillText(`${roundTime(Math.min(time, windowEnd))}s`, x - 16, canvas.height - 10);
  }

  timeWindowLabel.textContent = `${roundTime(state.viewStart)}s - ${roundTime(windowEnd)}s`;
  channelWindowLabel.textContent = `Channels ${state.channelStart + 1}-${state.channelStart + visibleChannels.length}`;
}

async function checkBackend() {
  try {
    const response = await fetch("/api/health");
    if (!response.ok) {
      throw new Error("Backend unavailable");
    }
    backendStatus.textContent = "Backend ready";
  } catch (error) {
    backendStatus.textContent = "Backend offline";
    backendStatus.classList.add("muted");
    addLog("Backend check failed. EDF conversion and clip export will not work until the server is running.");
  }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function convertEdf(action) {
  const file = state.lastEdfFile;
  if (!file) {
    addLog("Select an EDF file first.");
    return;
  }

  const actionLabel = action === "preview"
    ? "Opening EDF file..."
    : action === "segments"
      ? "Exporting EDF segments..."
      : "Exporting EDF as JSON...";
  beginLoading(actionLabel);

  try {
    await nextFrame();
    const formData = new FormData();
    formData.append("file", file);
    formData.append("action", action);
    formData.append("segment_duration", segmentDurationSelect.value);

    const response = await fetch("/api/edf/convert", {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: "Request failed." }));
      throw new Error(error.detail || "EDF conversion failed.");
    }

    if (action === "preview") {
      updateLoadingMessage("Parsing EDF response...");
      const data = await response.json();
      updateLoadingMessage("Rendering waveform...");
      await nextFrame();
      setDataset(data, file.name.replace(/\.edf$/i, ".json"), "EDF preview");
      return;
    }

    updateLoadingMessage("Preparing download...");
    const blob = await response.blob();
    const filename = action === "segments"
      ? file.name.replace(/\.edf$/i, "_segments.zip")
      : file.name.replace(/\.edf$/i, ".json");
    downloadBlob(blob, filename);
    addLog(`Downloaded ${filename}.`);
  } finally {
    endLoading();
  }
}

async function exportClips() {
  if (!state.eegData || state.selections.length === 0) {
    addLog("A dataset and at least one selection are required before export.");
    return;
  }

  beginLoading("Exporting selected clips...");
  try {
    await nextFrame();
    const response = await fetch("/api/clips/export", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        eeg_data: state.eegData,
        selections: state.selections,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: "Clip export failed." }));
      throw new Error(error.detail || "Clip export failed.");
    }

    updateLoadingMessage("Preparing clips download...");
    const blob = await response.blob();
    const stem = state.fileName ? state.fileName.replace(/\.json$/i, "") : "eeg";
    downloadBlob(blob, `${stem}_clips.zip`);
    addLog(`Exported ${state.selections.length} clips.`);
  } finally {
    endLoading();
  }
}

document.getElementById("load-json-btn").addEventListener("click", () => jsonInput.click());
document.getElementById("preview-edf-btn").addEventListener("click", () => edfInput.click());

document.getElementById("export-edf-json-btn").addEventListener("click", async () => {
  try {
    await convertEdf("full");
  } catch (error) {
    addLog(error.message);
  }
});

document.getElementById("export-edf-segments-btn").addEventListener("click", async () => {
  try {
    await convertEdf("segments");
  } catch (error) {
    addLog(error.message);
  }
});

document.getElementById("export-clips-btn").addEventListener("click", async () => {
  try {
    await exportClips();
  } catch (error) {
    addLog(error.message);
  }
});

document.getElementById("clear-selection-btn").addEventListener("click", () => {
  state.selections = [];
  updateSelectionList();
  addLog("Cleared all selections.");
  render();
});

jsonInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  beginLoading(`Loading ${file.name}...`);
  try {
    await nextFrame();
    const text = await file.text();
    updateLoadingMessage("Parsing JSON data...");
    const data = JSON.parse(text);
    updateLoadingMessage("Rendering waveform...");
    await nextFrame();
    setDataset(data, file.name, "JSON file");
  } finally {
    endLoading();
  }
});

edfInput.addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) {
    return;
  }

  state.lastEdfFile = file;
  addLog(`Selected EDF file ${file.name}.`);
  try {
    await convertEdf("preview");
  } catch (error) {
    addLog(error.message);
  }
});

visibleCountSelect.addEventListener("change", () => {
  state.visibleCount = Number(visibleCountSelect.value);
  syncControls();
  render();
});

windowSecondsSelect.addEventListener("change", () => {
  state.windowSeconds = Number(windowSecondsSelect.value);
  syncControls();
  render();
});

amplitudeScaleSelect.addEventListener("change", () => {
  state.amplitudeScale = Number(amplitudeScaleSelect.value);
  render();
});

rowSpacingSelect.addEventListener("change", () => {
  state.rowSpacing = Number(rowSpacingSelect.value);
  render();
});

timeScroll.addEventListener("input", () => {
  state.viewStart = Number(timeScroll.value);
  render();
});

channelScroll.addEventListener("input", () => {
  state.channelStart = Number(channelScroll.value);
  render();
});

canvas.addEventListener("mousedown", (event) => {
  if (!state.eegData) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  const localX = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const localY = ((event.clientY - rect.top) / rect.height) * canvas.height;
  const plot = getPlotRect();
  const withinPlot =
    localX >= plot.x && localX <= plot.x + plot.width && localY >= plot.y && localY <= plot.y + plot.height;
  if (!withinPlot) {
    return;
  }

  state.dragSelection = { startX: localX, currentX: localX };
});

canvas.addEventListener("mousemove", (event) => {
  if (!state.dragSelection) {
    return;
  }

  const rect = canvas.getBoundingClientRect();
  state.dragSelection.currentX = ((event.clientX - rect.left) / rect.width) * canvas.width;
  render();
});

window.addEventListener("mouseup", () => {
  if (!state.dragSelection) {
    return;
  }

  const plot = getPlotRect();
  const startTime = xToTime(state.dragSelection.startX, plot);
  const endTime = xToTime(state.dragSelection.currentX, plot);
  state.dragSelection = null;

  if (Math.abs(endTime - startTime) < 0.05) {
    render();
    return;
  }

  const selection = [Math.min(startTime, endTime), Math.max(startTime, endTime)];
  state.selections.push(selection);
  updateSelectionList();
  addLog(`Added selection ${roundTime(selection[0])}s - ${roundTime(selection[1])}s.`);
  render();
});

window.addEventListener("resize", render);

checkBackend();
updateMetadata();
updateSelectionList();
render();