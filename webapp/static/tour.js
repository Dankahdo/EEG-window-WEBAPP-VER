(() => {
  const startTourBtn = document.getElementById("start-tour-btn");
  const tourOverlay = document.getElementById("tour-overlay");
  const tourSpotlight = document.getElementById("tour-spotlight");
  const tourCard = document.getElementById("tour-card");
  const tourStepLabel = document.getElementById("tour-step-label");
  const tourTitle = document.getElementById("tour-title");
  const tourBody = document.getElementById("tour-body");
  const tourPrevBtn = document.getElementById("tour-prev-btn");
  const tourNextBtn = document.getElementById("tour-next-btn");
  const tourCloseBtn = document.getElementById("tour-close-btn");

  let activeTourStepIndex = -1;
  let activeTourTarget = null;

  const tourSteps = [
    {
      selector: ".artifact-button-row",
      title: "Load and Export Data",
      body: "Use these actions to open EEG JSON/EDF files and export full JSON, segments, or your selected clips.",
    },
    {
      selector: ".button-row",
      title: "Signal Display Controls",
      body: "Adjust time window, gain, montage, and row spacing to tune readability before making clips.",
    },
    {
      selector: "#page-controls",
      title: "Page Navigation",
      body: "Move through the recording with Previous/Next, type a page number, or use the mouse wheel over the page input.",
    },
    {
      selector: "#eeg-canvas",
      title: "Waveform Viewer",
      body: "Drag across the waveform area to create a clip. Event markers and selected regions are shown directly on the plot.",
    },
    {
      selector: ".channel-filter-panel",
      title: "Channel Filtering",
      body: "Pick which channels are shown to focus on specific leads before selecting clip windows.",
    },
    {
      selector: "#selection-list",
      title: "Clip Management",
      body: "Review clips here, jump to them, lock them against accidental edits, rename, or remove.",
    },
    {
      selector: "#activity-log",
      title: "Activity Log",
      body: "Track load/export operations and clip actions in this recent event timeline.",
    },
  ];

  function isTourOpen() {
    return activeTourStepIndex >= 0;
  }

  function clearTourHighlight() {
    if (!activeTourTarget) {
      return;
    }
    activeTourTarget.classList.remove("tour-highlight");
    activeTourTarget = null;
  }

  function positionTourSpotlight(target) {
    if (!tourSpotlight) {
      return;
    }

    const padding = 8;
    const rect = target.getBoundingClientRect();
    const left = Math.max(4, rect.left - padding);
    const top = Math.max(4, rect.top - padding);
    const width = Math.min(window.innerWidth - left - 4, rect.width + padding * 2);
    const height = Math.min(window.innerHeight - top - 4, rect.height + padding * 2);

    tourSpotlight.style.left = `${left}px`;
    tourSpotlight.style.top = `${top}px`;
    tourSpotlight.style.width = `${Math.max(20, width)}px`;
    tourSpotlight.style.height = `${Math.max(20, height)}px`;
  }

  function positionTourCardNearTarget(target) {
    if (!tourCard) {
      return;
    }

    const padding = 12;
    const rect = target.getBoundingClientRect();
    const cardRect = tourCard.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - cardRect.width / 2;
    let top = rect.bottom + 12;

    if (left + cardRect.width + padding > window.innerWidth) {
      left = window.innerWidth - cardRect.width - padding;
    }
    if (left < padding) {
      left = padding;
    }
    if (top + cardRect.height + padding > window.innerHeight) {
      top = rect.top - cardRect.height - 12;
    }
    if (top < padding) {
      top = padding;
    }

    tourCard.style.left = `${left}px`;
    tourCard.style.top = `${top}px`;
  }

  function showTourStep(stepIndex) {
    if (!tourOverlay || !tourTitle || !tourBody || !tourStepLabel || !tourPrevBtn || !tourNextBtn) {
      return;
    }

    const clamped = Math.max(0, Math.min(tourSteps.length - 1, stepIndex));
    activeTourStepIndex = clamped;
    const step = tourSteps[clamped];

    tourTitle.textContent = step.title;
    tourBody.textContent = step.body;
    tourStepLabel.textContent = `Step ${clamped + 1} / ${tourSteps.length}`;
    tourPrevBtn.disabled = clamped === 0;
    tourNextBtn.textContent = clamped === tourSteps.length - 1 ? "Finish" : "Next";

    clearTourHighlight();
    const target = document.querySelector(step.selector);
    if (!target) {
      return;
    }

    activeTourTarget = target;
    activeTourTarget.classList.add("tour-highlight");
    positionTourSpotlight(target);

    const targetRect = target.getBoundingClientRect();
    const viewportMargin = 24;
    const needsScrollIntoView =
      targetRect.top < viewportMargin ||
      targetRect.bottom > window.innerHeight - viewportMargin;

    if (needsScrollIntoView) {
      target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      window.setTimeout(() => {
        if (activeTourTarget === target) {
          positionTourSpotlight(target);
          positionTourCardNearTarget(target);
        }
      }, 180);
      return;
    }

    positionTourCardNearTarget(target);
  }

  function closeTour() {
    if (!tourOverlay) {
      return;
    }
    clearTourHighlight();
    activeTourStepIndex = -1;
    tourOverlay.classList.remove("active");
    tourOverlay.setAttribute("aria-hidden", "true");
  }

  function openTour() {
    if (!tourOverlay || tourSteps.length === 0) {
      return;
    }
    tourOverlay.classList.add("active");
    tourOverlay.setAttribute("aria-hidden", "false");
    showTourStep(0);
  }

  function goToNextTourStep() {
    if (!isTourOpen()) {
      return;
    }
    if (activeTourStepIndex >= tourSteps.length - 1) {
      closeTour();
      return;
    }
    showTourStep(activeTourStepIndex + 1);
  }

  function goToPreviousTourStep() {
    if (!isTourOpen()) {
      return;
    }
    showTourStep(activeTourStepIndex - 1);
  }

  if (startTourBtn) {
    startTourBtn.addEventListener("click", openTour);
  }

  if (tourPrevBtn) {
    tourPrevBtn.addEventListener("click", goToPreviousTourStep);
  }

  if (tourNextBtn) {
    tourNextBtn.addEventListener("click", goToNextTourStep);
  }

  if (tourCloseBtn) {
    tourCloseBtn.addEventListener("click", closeTour);
  }

  if (tourOverlay) {
    tourOverlay.addEventListener("click", (event) => {
      if (event.target === tourOverlay) {
        closeTour();
      }
    });
  }

  window.addEventListener("keydown", (event) => {
    if (!isTourOpen()) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      closeTour();
      return;
    }
    if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      goToNextTourStep();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      goToPreviousTourStep();
    }
  });

  window.addEventListener("resize", () => {
    if (isTourOpen() && activeTourTarget) {
      positionTourSpotlight(activeTourTarget);
      positionTourCardNearTarget(activeTourTarget);
    }
  });

  window.addEventListener("scroll", () => {
    if (isTourOpen() && activeTourTarget) {
      positionTourSpotlight(activeTourTarget);
      positionTourCardNearTarget(activeTourTarget);
    }
  }, { passive: true });
})();
