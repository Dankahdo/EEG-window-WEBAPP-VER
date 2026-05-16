const state = {
  eegData: null,
  fileName: null,
  selections: [],
  nextSelectionId: 1,
  visibleCount: 6,
  viewStart: 0,
  currentPage: 0,
  currentMontageId: "raw_referential",
  windowSeconds: 10,
  amplitudeScale: 1,
  rowSpacing: 110,
  montageChannels: [],
  selectedChannels: new Set(),
  channelStats: {},
  focusedSelectionId: null,
  focusStartedAtMs: 0,
  focusDurationMs: 900,
  focusAnimationFrameId: null,
  dragSelection: null,
  lastEdfFile: null,
};

const canvas = document.getElementById("eeg-canvas");
const context = canvas.getContext("2d");
const jsonInput = document.getElementById("json-input");
const edfInput = document.getElementById("edf-input");
const datasetStatus = document.getElementById("dataset-status");
const backendStatus = document.getElementById("backend-status");
const pagePrevBtn = document.getElementById("page-prev-btn");
const pageNextBtn = document.getElementById("page-next-btn");
const pageIndicator = document.getElementById("page-indicator");
const visibleCountSelect = document.getElementById("visible-count-select");
const montageSelect = document.getElementById("montage-select");
const windowSecondsSelect = document.getElementById("window-seconds-select");
const amplitudeScaleSelect = document.getElementById("amplitude-scale-select");
const rowSpacingSelect = document.getElementById("row-spacing-select");
const segmentDurationSelect = document.getElementById("segment-duration-select");
const channelFilterAll = document.getElementById("channel-filter-all");
const channelFilterList = document.getElementById("channel-filter-list");
const metadataGrid = document.getElementById("metadata-grid");
const selectionList = document.getElementById("selection-list");
const selectionCount = document.getElementById("selection-count");
const activityLog = document.getElementById("activity-log");
const timeWindowLabel = document.getElementById("time-window-label");
const channelWindowLabel = document.getElementById("channel-window-label");
const loadingOverlay = document.getElementById("loading-overlay");
const loadingMessage = document.getElementById("loading-message");
const selectionHoverLegend = document.getElementById("selection-hover-legend");
const visibleCountChip = visibleCountSelect?.closest(".control-chip");

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

function scheduleStabilizedRender() {
  // Some browsers may paint the first canvas frame before layout settles after large EDF loads.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      render();
    });
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

function getMontageConfig() {
  return window.EEG_MONTAGE_CONFIG || { defaultMontageId: "raw_referential", montages: [] };
}

function getDisplayChannels() {
  return Array.isArray(state.montageChannels) ? state.montageChannels : [];
}

function getDisplayChannelNames() {
  return getDisplayChannels().map((channel) => channel.channel_name);
}

function getDisplayChannelData(channelName) {
  return getDisplayChannels().find((channel) => channel.channel_name === channelName)?.y ?? [];
}

function normalizeChannelName(name) {
  return String(name || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function buildSourceChannelMap(data) {
  const map = new Map();
  const channels = Array.isArray(data?.channels) ? data.channels : [];
  channels.forEach((channel) => {
    const key = normalizeChannelName(channel.channel_name);
    if (key && !map.has(key)) {
      map.set(key, channel.y ?? []);
    }
  });
  return map;
}

function resolveSourceTrace(sourceMap, candidates) {
  const names = Array.isArray(candidates) ? candidates : [candidates];
  for (const name of names) {
    const trace = sourceMap.get(normalizeChannelName(name));
    if (trace) {
      return trace;
    }
  }
  return null;
}

function buildRawMontageChannels(data) {
  const channels = Array.isArray(data?.channels) ? data.channels : [];
  return channels.map((channel) => ({
    channel_name: channel.channel_name,
    y: (channel.y ?? []).map((value) => Number(value) || 0),
  }));
}

function buildBipolarMontageChannels(data, montage) {
  const sourceMap = buildSourceChannelMap(data);
  const pairs = Array.isArray(montage?.pairs) ? montage.pairs : [];
  const derived = [];

  pairs.forEach((pair) => {
    const fromTrace = resolveSourceTrace(sourceMap, pair.from);
    const toTrace = resolveSourceTrace(sourceMap, pair.to);
    if (!fromTrace || !toTrace) {
      return;
    }

    const length = Math.min(fromTrace.length, toTrace.length);
    const values = new Array(length);
    for (let index = 0; index < length; index += 1) {
      values[index] = (Number(fromTrace[index]) || 0) - (Number(toTrace[index]) || 0);
    }

    derived.push({
      channel_name: pair.name,
      y: values,
    });
  });

  return derived;
}

function buildMontageChannels(data, montageId) {
  const config = getMontageConfig();
  const montages = Array.isArray(config.montages) ? config.montages : [];
  const montage = montages.find((entry) => entry.id === montageId) || montages.find((entry) => entry.id === config.defaultMontageId);

  if (!montage || montage.type === "raw") {
    return buildRawMontageChannels(data);
  }

  if (montage.type === "bipolar") {
    return buildBipolarMontageChannels(data, montage);
  }

  return buildRawMontageChannels(data);
}

function populateMontageSelect() {
  if (!montageSelect) {
    return;
  }

  const config = getMontageConfig();
  const montages = Array.isArray(config.montages) ? config.montages : [];

  montageSelect.innerHTML = "";
  montages.forEach((montage) => {
    const option = document.createElement("option");
    option.value = montage.id;
    option.textContent = montage.label;
    montageSelect.append(option);
  });

  const defaultId = config.defaultMontageId || "raw_referential";
  state.currentMontageId = montages.some((entry) => entry.id === defaultId)
    ? defaultId
    : (montages[0]?.id || "raw_referential");
  montageSelect.value = state.currentMontageId;
}

function applyMontage(montageId, options = {}) {
  const { resetFilters = false, emitLog = false } = options;
  state.currentMontageId = montageId;
  state.montageChannels = buildMontageChannels(state.eegData, montageId);

  if (state.eegData && state.montageChannels.length === 0 && montageId !== "raw_referential") {
    state.currentMontageId = "raw_referential";
    state.montageChannels = buildMontageChannels(state.eegData, state.currentMontageId);
    if (montageSelect) {
      montageSelect.value = state.currentMontageId;
    }
    addLog("Selected montage was unavailable for this file. Reverted to Raw Referential.");
  }

  state.channelStats = buildChannelStats(state.montageChannels);

  if (resetFilters) {
    state.selectedChannels = new Set(getDisplayChannelNames());
  } else {
    const available = new Set(getDisplayChannelNames());
    state.selectedChannels = new Set([...state.selectedChannels].filter((name) => available.has(name)));
    if (state.selectedChannels.size === 0) {
      state.selectedChannels = new Set(available);
    }
  }

  renderChannelFilters();
  if (emitLog) {
    const selectedLabel = montageSelect?.selectedOptions?.[0]?.textContent || montageId;
    addLog(`Switched montage to ${selectedLabel}.`);
  }
}

function getVisibleChannelNames() {
  if (!state.eegData) {
    return [];
  }
  const allNames = getDisplayChannelNames();
  return allNames.filter((name) => state.selectedChannels.has(name));
}

function getDurationSeconds() {
  return Number(state.eegData?.duration_seconds || 0);
}

function getPageCount() {
  const duration = getDurationSeconds();
  if (!duration || state.windowSeconds <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(duration / state.windowSeconds));
}

function getPageStart(pageIndex, maxTimeStart) {
  const pageStart = pageIndex * state.windowSeconds;
  return Math.min(maxTimeStart, pageStart);
}

function updatePageControls() {
  const pageCount = getPageCount();
  const maxPage = Math.max(0, pageCount - 1);

  if (pageIndicator) {
    pageIndicator.textContent = `Page ${state.currentPage + 1} / ${pageCount}`;
  }

  if (pagePrevBtn) {
    pagePrevBtn.disabled = state.currentPage <= 0;
  }

  if (pageNextBtn) {
    pageNextBtn.disabled = state.currentPage >= maxPage;
  }
}

function goToPreviousPage() {
  const maxTimeStart = Math.max(0, getDurationSeconds() - state.windowSeconds);
  state.currentPage = Math.max(0, state.currentPage - 1);
  state.viewStart = getPageStart(state.currentPage, maxTimeStart);
  render();
}

function goToNextPage() {
  const maxTimeStart = Math.max(0, getDurationSeconds() - state.windowSeconds);
  const maxPage = Math.max(0, getPageCount() - 1);
  state.currentPage = Math.min(maxPage, state.currentPage + 1);
  state.viewStart = getPageStart(state.currentPage, maxTimeStart);
  render();
}

function isTypingTarget(target) {
  if (!target) {
    return false;
  }
  const tagName = String(target.tagName || "").toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select" || target.isContentEditable;
}

function buildChannelStats(channels) {
  const stats = {};
  channels.forEach((channel) => {
    const values = (channel.y ?? []).map((value) => Number(value) || 0);
    if (!values.length) {
      stats[channel.channel_name] = { mean: 0, maxAbs: 1 };
      return;
    }

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    let maxAbs = 0;
    for (const value of values) {
      maxAbs = Math.max(maxAbs, Math.abs(value - mean));
    }

    stats[channel.channel_name] = { mean, maxAbs: maxAbs || 1 };
  });

  return stats;
}

function syncControls() {
  const duration = getDurationSeconds();
  const maxTimeStart = Math.max(0, duration - state.windowSeconds);
  const pageCount = getPageCount();
  const maxPage = Math.max(0, pageCount - 1);

  const derivedPage = Math.round(state.viewStart / Math.max(0.0001, state.windowSeconds));
  state.currentPage = Math.max(0, Math.min(maxPage, Number.isFinite(derivedPage) ? derivedPage : 0));
  state.viewStart = getPageStart(state.currentPage, maxTimeStart);

  updatePageControls();
}

function syncCanvasHeight() {
  if (!state.eegData) {
    canvas.height = 760;
    return;
  }

  const channelCount = Math.max(1, getVisibleChannelNames().length);
  const targetHeight = Math.max(760, Math.round(layout.top + layout.bottom + channelCount * state.rowSpacing));
  if (canvas.height !== targetHeight) {
    canvas.height = targetHeight;
  }
}

function syncChannelFilterAllState() {
  if (!channelFilterAll) {
    return;
  }

  const names = getDisplayChannelNames();
  const selectedCount = names.filter((name) => state.selectedChannels.has(name)).length;

  channelFilterAll.disabled = names.length === 0;
  channelFilterAll.checked = names.length > 0 && selectedCount === names.length;
  channelFilterAll.indeterminate = selectedCount > 0 && selectedCount < names.length;
}

function renderChannelFilters() {
  if (!channelFilterList) {
    return;
  }

  channelFilterList.innerHTML = "";
  const names = getDisplayChannelNames();

  if (names.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Load a dataset to choose channels.";
    channelFilterList.append(empty);
    syncChannelFilterAllState();
    return;
  }

  names.forEach((name) => {
    const item = document.createElement("label");
    item.className = "channel-filter-item";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.selectedChannels.has(name);
    input.addEventListener("change", () => {
      if (input.checked) {
        state.selectedChannels.add(name);
      } else {
        state.selectedChannels.delete(name);
      }
      syncChannelFilterAllState();
      render();
    });

    const label = document.createElement("span");
    label.textContent = name;

    item.append(input, label);
    channelFilterList.append(item);
  });

  syncChannelFilterAllState();
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

function getSortedSelections() {
  return state.selections
    .slice()
    .sort((left, right) => (left.start - right.start) || (left.id - right.id));
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

  getSortedSelections().forEach(({ id, start, end, name }) => {
      const item = document.createElement("div");
      item.className = "selection-item";

      const label = document.createElement("button");
      label.type = "button";
      label.className = "selection-jump";
      label.title = "Jump to clip page";
      label.innerHTML = `<strong>${name}</strong><span>${roundTime(start)}s - ${roundTime(end)}s</span>`;
      label.addEventListener("click", () => {
        jumpToSelectionPage(id, start);
      });

      const renameButton = document.createElement("button");
      renameButton.type = "button";
      renameButton.className = "selection-rename";
      renameButton.textContent = "Rename";
      renameButton.addEventListener("click", () => {
        const nextNameRaw = window.prompt("Enter a new clip name:", name);
        if (nextNameRaw === null) {
          return;
        }
        const nextName = nextNameRaw.trim();
        if (!nextName) {
          return;
        }
        const selection = state.selections.find((entry) => entry.id === id);
        if (!selection) {
          return;
        }
        selection.name = nextName;
        updateSelectionList();
        render();
      });

      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Remove";
      button.addEventListener("click", () => {
        state.selections = state.selections.filter((selection) => selection.id !== id);
        updateSelectionList();
        render();
      });

      const actions = document.createElement("div");
      actions.className = "selection-actions";
      actions.append(renameButton, button);

      item.append(label, actions);
      selectionList.append(item);
  });
}

function hideSelectionHoverLegend() {
  if (!selectionHoverLegend) {
    return;
  }
  selectionHoverLegend.classList.remove("active");
  selectionHoverLegend.setAttribute("aria-hidden", "true");
}

function startSelectionFocusAnimation(selectionId) {
  state.focusedSelectionId = selectionId;
  state.focusStartedAtMs = performance.now();

  if (state.focusAnimationFrameId !== null) {
    cancelAnimationFrame(state.focusAnimationFrameId);
    state.focusAnimationFrameId = null;
  }

  const step = () => {
    const elapsed = performance.now() - state.focusStartedAtMs;
    render();
    if (elapsed < state.focusDurationMs) {
      state.focusAnimationFrameId = requestAnimationFrame(step);
      return;
    }

    state.focusedSelectionId = null;
    state.focusAnimationFrameId = null;
    render();
  };

  state.focusAnimationFrameId = requestAnimationFrame(step);
}

function showSelectionHoverLegend(content, clientX, clientY) {
  if (!selectionHoverLegend) {
    return;
  }

  selectionHoverLegend.innerHTML = content;
  selectionHoverLegend.classList.add("active");
  selectionHoverLegend.setAttribute("aria-hidden", "false");

  const padding = 12;
  const rect = selectionHoverLegend.getBoundingClientRect();
  let left = clientX + 14;
  let top = clientY + 14;

  if (left + rect.width + padding > window.innerWidth) {
    left = Math.max(padding, clientX - rect.width - 14);
  }
  if (top + rect.height + padding > window.innerHeight) {
    top = Math.max(padding, clientY - rect.height - 14);
  }

  selectionHoverLegend.style.left = `${left}px`;
  selectionHoverLegend.style.top = `${top}px`;
}

function updateSelectionHoverLegend(localX, localY, clientX, clientY) {
  if (!state.eegData || state.selections.length === 0 || state.dragSelection) {
    hideSelectionHoverLegend();
    return;
  }

  const plot = getPlotRect();
  const withinPlot =
    localX >= plot.x && localX <= plot.x + plot.width && localY >= plot.y && localY <= plot.y + plot.height;
  if (!withinPlot) {
    hideSelectionHoverLegend();
    return;
  }

  const hoveredTime = xToTime(localX, plot);
  const hits = getSortedSelections().filter(({ start, end }) => hoveredTime >= start && hoveredTime <= end);

  if (hits.length === 0) {
    hideSelectionHoverLegend();
    return;
  }

  const lines = hits.map(({ name, start, end }) => `${name}: ${roundTime(start)}s - ${roundTime(end)}s`);
  const content = lines.join("<br />");
  showSelectionHoverLegend(content, clientX, clientY);
}

function jumpToSelectionPage(selectionId, startTime) {
  if (!state.eegData) {
    return;
  }

  const maxTimeStart = Math.max(0, getDurationSeconds() - state.windowSeconds);
  const maxPage = Math.max(0, getPageCount() - 1);
  const pageIndex = Math.floor(Math.max(0, startTime) / Math.max(0.0001, state.windowSeconds));

  state.currentPage = Math.max(0, Math.min(maxPage, pageIndex));
  state.viewStart = getPageStart(state.currentPage, maxTimeStart);
  startSelectionFocusAnimation(selectionId);
  render();
}

function setDataset(data, fileName, sourceLabel) {
  state.eegData = data;
  state.fileName = fileName;
  state.selections = [];
  state.nextSelectionId = 1;
  state.focusedSelectionId = null;
  state.viewStart = 0;
  state.currentPage = 0;
  applyMontage(state.currentMontageId, { resetFilters: true });
  syncControls();
  updateMetadata();
  updateSelectionList();
  datasetStatus.textContent = `${sourceLabel}: ${fileName}`;
  addLog(`Loaded ${fileName} from ${sourceLabel}.`);
  render();
  scheduleStabilizedRender();
}

function downsampleTrace(times, values, maxPoints, startIndex = 0) {
  if (times.length <= maxPoints) {
    return { times, values };
  }

  const resultTimes = [];
  const resultValues = [];
  const bucketSize = Math.max(1, Math.ceil(times.length / maxPoints));
  const anchoredOffset = Math.max(0, startIndex % bucketSize);

  for (let index = anchoredOffset; index < times.length; index += bucketSize) {
    resultTimes.push(times[index]);
    resultValues.push(values[index]);
  }

  if (resultTimes.length === 0 && times.length > 0) {
    resultTimes.push(times[0]);
    resultValues.push(values[0]);
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
    syncCanvasHeight();
    renderEmptyState();
    return;
  }

  syncControls();
  syncCanvasHeight();

  const rect = getPlotRect();
  const allTimes = getTimeVector(state.eegData);
  const windowEnd = Math.min(getDurationSeconds(), state.viewStart + state.windowSeconds);
  const visibleChannels = getVisibleChannelNames();
  const rowHeight = state.rowSpacing;

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

  const nowMs = performance.now();
  getSortedSelections().forEach(({ id, start, end }) => {
    if (end < state.viewStart || start > windowEnd) {
      return;
    }
    const left = timeToX(Math.max(start, state.viewStart), rect);
    const right = timeToX(Math.min(end, windowEnd), rect);
    let fillStyle = "rgba(246, 189, 22, 0.24)";

    if (state.focusedSelectionId === id) {
      const elapsed = Math.max(0, nowMs - state.focusStartedAtMs);
      const t = Math.min(1, elapsed / Math.max(1, state.focusDurationMs));
      const red = Math.round(22 + (246 - 22) * t);
      const green = Math.round(93 + (189 - 93) * t);
      const blue = Math.round(255 + (22 - 255) * t);
      const alpha = 0.34 - 0.1 * t;
      fillStyle = `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(3)})`;
    }

    context.fillStyle = fillStyle;
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
    const values = getDisplayChannelData(channelName);

    const startIndex = allTimes.findIndex((time) => time >= state.viewStart);
    let endIndex = allTimes.findIndex((time) => time > windowEnd);
    const boundedStart = startIndex === -1 ? 0 : startIndex;
    if (endIndex === -1) {
      endIndex = allTimes.length;
    }

    const sliceTimes = allTimes.slice(boundedStart, endIndex);
    const sliceValues = values.slice(boundedStart, endIndex);
    const reduced = downsampleTrace(sliceTimes, sliceValues, Math.max(300, Math.floor(rect.width / 2)), boundedStart);
    const channelStats = state.channelStats[channelName] || { mean: 0, maxAbs: 1 };

    // Keep each channel on a stable baseline/scale across time pans.
    const numericValues = reduced.values.map((value) => Number(value) || 0);
    const centeredValues = numericValues.map((value) => value - channelStats.mean);
    const maxAbs = channelStats.maxAbs;

    context.strokeStyle = "rgba(15, 23, 42, 0.10)";
    context.beginPath();
    context.moveTo(rect.x, bottom);
    context.lineTo(rect.x + rect.width, bottom);
    context.stroke();

    context.fillStyle = "#0f172a";
    context.font = "18px Bahnschrift, Segoe UI Variable, sans-serif";
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
  channelWindowLabel.textContent = `${visibleChannels.length}/${getDisplayChannelNames().length} channels shown`;
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
        selections: state.selections.map((selection) => [selection.start, selection.end]),
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

if (pagePrevBtn) {
  pagePrevBtn.addEventListener("click", goToPreviousPage);
}

if (pageNextBtn) {
  pageNextBtn.addEventListener("click", goToNextPage);
}

window.addEventListener("keydown", (event) => {
  if (!state.eegData || isTypingTarget(event.target)) {
    return;
  }

  if (event.key === "a" || event.key === "A" || event.key === "ArrowLeft") {
    event.preventDefault();
    goToPreviousPage();
    return;
  }

  if (event.key === "d" || event.key === "D" || event.key === "ArrowRight") {
    event.preventDefault();
    goToNextPage();
  }
});

if (channelFilterAll) {
  channelFilterAll.addEventListener("change", () => {
    const names = getDisplayChannelNames();
    state.selectedChannels = channelFilterAll.checked ? new Set(names) : new Set();
    renderChannelFilters();
    render();
  });
}

if (montageSelect) {
  montageSelect.addEventListener("change", () => {
    state.currentMontageId = montageSelect.value;
    if (!state.eegData) {
      return;
    }
    applyMontage(state.currentMontageId, { resetFilters: true, emitLog: true });
    updateMetadata();
    render();
  });
}

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
  const rect = canvas.getBoundingClientRect();
  const localX = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const localY = ((event.clientY - rect.top) / rect.height) * canvas.height;

  if (!state.dragSelection) {
    updateSelectionHoverLegend(localX, localY, event.clientX, event.clientY);
    return;
  }

  state.dragSelection.currentX = ((event.clientX - rect.left) / rect.width) * canvas.width;
  hideSelectionHoverLegend();
  render();
});

canvas.addEventListener("mouseleave", () => {
  hideSelectionHoverLegend();
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

  const selection = {
    id: state.nextSelectionId,
    name: `Clip ${state.nextSelectionId}`,
    start: Math.min(startTime, endTime),
    end: Math.max(startTime, endTime),
  };
  state.nextSelectionId += 1;
  state.selections.push(selection);
  updateSelectionList();
  addLog(`Added ${selection.name} ${roundTime(selection.start)}s - ${roundTime(selection.end)}s.`);
  render();
});

window.addEventListener("resize", render);

if (visibleCountChip) {
  visibleCountChip.style.display = "none";
}

populateMontageSelect();
renderChannelFilters();
checkBackend();
updateMetadata();
updateSelectionList();
render();