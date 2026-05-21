const form = document.querySelector("#reviewForm");
const statusPill = document.querySelector("#statusPill");
const progress = document.querySelector("#progress");
const report = document.querySelector("#report");
const emptyState = document.querySelector("#emptyState");
const reportTitle = document.querySelector("#reportTitle");
const downloadReport = document.querySelector("#downloadReport");
const recordingStatus = document.querySelector("#recordingStatus");
const uploadSummary = document.querySelector("#uploadSummary");
const recordingInput = form.elements.recording;
const reviewTypeInput = document.querySelector("#reviewType");
const intakeInput = form.elements.intake;
const scriptInput = document.querySelector("#script");
const processInput = document.querySelector("#process");
const previousReviewsButton = document.querySelector("#previousReviewsButton");
const previousReviewsPanel = document.querySelector("#previousReviewsPanel");
const previousReviewsList = document.querySelector("#previousReviewsList");
const batchPatternsButton = document.querySelector("#batchPatternsButton");
const batchPatternsPanel = document.querySelector("#batchPatternsPanel");
const batchPatternForm = document.querySelector("#batchPatternForm");
const batchPatternStatus = document.querySelector("#batchPatternStatus");
const batchPatternReport = document.querySelector("#batchPatternReport");
const textLikeExtensions = [".txt", ".csv", ".json", ".md", ".log"];
const serverReadableExtensions = [".docx", ".xlsx", ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".gif"];
const uploadInputs = ["recording", "intakeFile", "scriptFile", "processFile"];
const maxUploadMb = 200;
let latestKeyFindingsText = "";
let latestReviewPayload = null;

checkHealth();
loadDefaults();
updateRecordingStatus();
updateUploadSummary();

recordingInput.addEventListener("change", updateRecordingStatus);
reviewTypeInput.addEventListener("change", () => loadDefaults(true));
previousReviewsButton?.addEventListener("click", openPreviousReviews);
batchPatternsButton?.addEventListener("click", () => {
  batchPatternsPanel.classList.toggle("hidden");
  previousReviewsPanel.classList.add("hidden");
});
batchPatternForm?.addEventListener("submit", reviewBatchPatterns);
document.querySelectorAll("[data-close-panel]").forEach((button) => {
  button.addEventListener("click", () => document.querySelector(`#${button.dataset.closePanel}`)?.classList.add("hidden"));
});
uploadInputs.forEach((name) => {
  const input = form.elements[name] || document.querySelector(`#${name}`);
  input?.addEventListener("change", updateUploadSummary);
});

document.querySelectorAll("[data-load-file]").forEach((button) => {
  button.addEventListener("click", async () => {
    const input = document.querySelector(`#${button.dataset.loadFile}`);
    const target = document.querySelector(`#${button.dataset.target}`);
    if (!input.files?.[0]) {
      input.click();
      input.onchange = () => loadFileIntoTextarea(input, target);
      return;
    }
    await loadFileIntoTextarea(input, target);
  });
});

document.querySelectorAll("#intakeFile, #scriptFile, #processFile").forEach((input) => {
  input.addEventListener("change", async () => {
    const targetId = input.id.replace("File", "");
    const target = document.querySelector(`#${targetId}`);
    await loadFileIntoTextarea(input, target);
    if (input.id === "intakeFile" && input.files?.[0]) {
      reportTitle.textContent = "Intake file selected";
      renderEmpty(target.value.trim()
        ? "The intake form is loaded. Choose the recording and click Review call."
        : "The intake form is selected and will be read when the review starts. Choose the recording and click Review call.");
    }
  });
});

document.querySelectorAll("[data-save-defaults]").forEach((button) => {
  button.addEventListener("click", saveDefaults);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!recordingInput.files?.length) {
    reportTitle.textContent = "Choose recording";
    renderEmpty("Please choose at least one call recording before starting the review.", true);
    recordingInput.focus();
    return;
  }

  try {
    const totalMb = getSelectedFiles().reduce((sum, file) => sum + file.size, 0) / 1024 / 1024;
    if (totalMb > maxUploadMb) {
      reportTitle.textContent = "Files too large";
      renderEmpty(`The selected files total ${totalMb.toFixed(1)} MB. The current app limit is ${maxUploadMb} MB. Try a smaller MP3 or remove extra large reference files.`, true);
      return;
    }

    reportTitle.textContent = "Checking app service";
    renderEmpty("Checking that the local review service is available.");
    await fetchWithTimeout("/api/health", { method: "GET" }, 10000);

    const body = new FormData(form);
    setBusy(true);
    reportTitle.textContent = "Uploading files";
    renderEmpty(`Uploading ${getSelectedFiles().length} file(s), ${totalMb.toFixed(1)} MB total. Keep this page open.`);

    const response = await fetchWithTimeout("/api/analyze", {
      method: "POST",
      body
    }, 300000);
    reportTitle.textContent = "Review in progress";
    renderEmpty("Files were received. Transcribing and reviewing the call.");
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "The review could not be completed.");
    renderReport(payload);
  } catch (error) {
    const message = error.name === "AbortError"
      ? "The upload or review did not finish within 5 minutes. Try a smaller MP3 first, or test with only the MP3 and DOCX intake before adding the PDF/JPG references."
      : error.message === "Failed to fetch"
      ? "The browser could not reach the local review service while sending the files. The app is running, so try once more after refreshing. If it repeats, check data/server.log in the project folder."
      : error.message || "Something went wrong.";
    renderError(message);
  } finally {
    setBusy(false);
  }
});

form.addEventListener("reset", () => {
  window.setTimeout(async () => {
    report.classList.add("hidden");
    report.innerHTML = "";
    downloadReport.classList.add("hidden");
    reportTitle.textContent = "Ready for a call";
    await loadDefaults();
  renderEmpty("Choose one or more recordings for the same intake. Add the completed intake form if it exists, or leave intake blank to review script/process only.");
  }, 0);
});

async function checkHealth() {
  try {
    const response = await fetch("/api/health");
    const health = await response.json();
    statusPill.textContent = health.hasApiKey ? "Ready" : "Needs API key";
    statusPill.classList.toggle("warning", !health.hasApiKey);
    statusPill.title = health.hasApiKey
      ? `Transcription: ${health.transcriptionModel}; QA: ${health.qaModel}`
      : "Set OPENAI_API_KEY before starting the app.";
  } catch {
    statusPill.textContent = "Offline";
    statusPill.classList.add("warning");
  }
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

async function loadDefaults(replaceCurrent = false) {
  try {
    const response = await fetch(`/api/defaults?type=${encodeURIComponent(reviewTypeInput.value)}`);
    if (!response.ok) return;
    const defaults = await response.json();
    if (replaceCurrent || !scriptInput.value.trim()) scriptInput.value = defaults.script || "";
    if (replaceCurrent || !processInput.value.trim()) processInput.value = defaults.process || "";
    if (defaults.script || defaults.process) {
      reportTitle.textContent = "Ready for a call";
      renderEmpty(`${labelReviewType(reviewTypeInput.value)} defaults are loaded. Choose one or more recordings for the same intake and add the intake form when it exists.`);
    } else if (replaceCurrent) {
      reportTitle.textContent = "No saved defaults";
      renderEmpty(`${labelReviewType(reviewTypeInput.value)} does not have saved script/process defaults yet. Load or paste them, then click Save as default.`);
    }
  } catch {
    // Defaults are optional; the app can still review calls without them.
  }
}

async function saveDefaults() {
  try {
    if (!scriptInput.value.trim() && !processInput.value.trim()) {
      renderEmpty("There is no script or process text to save yet. Load or paste the debt script/policies first, then click Save as default.", true);
      return;
    }

    const response = await fetch("/api/defaults", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: reviewTypeInput.value,
        script: scriptInput.value,
        process: processInput.value
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Defaults could not be saved.");
    reportTitle.textContent = "Defaults saved";
    renderEmpty(`${labelReviewType(reviewTypeInput.value)} script and process rules are saved. Future reviews with this type selected will use them automatically.`);
  } catch (error) {
    renderError(error.message || "Defaults could not be saved.");
  }
}

async function openPreviousReviews() {
  previousReviewsPanel.classList.remove("hidden");
  batchPatternsPanel.classList.add("hidden");
  previousReviewsList.innerHTML = `<p class="quiet">Loading saved reviews...</p>`;
  try {
    const response = await fetch("/api/reports");
    const reviews = await response.json();
    if (!response.ok) throw new Error("Previous reviews could not be loaded.");
    if (!reviews.length) {
      previousReviewsList.innerHTML = `<p class="quiet">No saved reviews found yet.</p>`;
      return;
    }
    previousReviewsList.innerHTML = reviews.map((item) => `
      <article class="review-row">
        <div>
          <strong>${escapeHtml(reviewListTitle(item))}</strong>
          <span>${escapeHtml(formatReviewDate(item.createdAt))} · ${escapeHtml(labelReviewType(item.reviewType))} · ${escapeHtml(item.overallStatus || "saved")}</span>
        </div>
        <button class="secondary" type="button" data-open-report="${escapeHtml(item.file)}">Open</button>
      </article>
    `).join("");
    previousReviewsList.querySelectorAll("[data-open-report]").forEach((button) => {
      button.addEventListener("click", () => openSavedReport(button.dataset.openReport));
    });
  } catch (error) {
    previousReviewsList.innerHTML = `<p class="quiet">${escapeHtml(error.message || "Previous reviews could not be loaded.")}</p>`;
  }
}

async function openSavedReport(file) {
  try {
    const response = await fetch(`/reports/${encodeURIComponent(file)}`);
    const payload = await response.json();
    if (!response.ok) throw new Error("Saved report could not be opened.");
    previousReviewsPanel.classList.add("hidden");
    if (payload.recordings && payload.report?.patterns) {
      renderBatchPatternReport(payload);
      batchPatternsPanel.classList.remove("hidden");
      return;
    }
    renderReport({ ...payload, reportUrl: `/reports/${encodeURIComponent(file)}` });
  } catch (error) {
    previousReviewsList.innerHTML = `<p class="quiet">${escapeHtml(error.message || "Saved report could not be opened.")}</p>`;
  }
}

function reviewListTitle(item) {
  if (item.isBatch) return item.caseName || item.file.replace(/\.json$/i, "");
  const phone = item.leadPhoneNumber || extractPhoneFromFilename(item.originalRecording) || "No phone";
  const type = item.reviewType === "debt" ? "Debt" : normalizeTortType(item.tortType) || "Unknown tort";
  return buildReportName(phone, type);
}

function labelReviewType(value) {
  if (value === "batch") return "Batch pattern";
  return value === "mass_tort" ? "Mass Tort QC" : "Debt QC";
}

async function loadFileIntoTextarea(input, target) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  const ext = getExtension(file.name);

  if (textLikeExtensions.includes(ext)) {
    try {
      target.value = await file.text();
    } catch {
      renderEmpty("That file could not be read in the browser. Try exporting it as CSV or text, then load it again.", true);
    }
    return;
  }

  if (ext === ".doc") {
    input.value = "";
    target.value = "";
    renderEmpty(`${file.name} is an older Word .doc file. Open it in Word, save it as .docx, then load the .docx file.`, true);
    return;
  }

  if (ext === ".xls") {
    input.value = "";
    target.value = "";
    renderEmpty(`${file.name} is an older Excel .xls file. Save it as .xlsx or CSV, then load it again.`, true);
    return;
  }

  if (serverReadableExtensions.includes(ext)) {
    target.value = "";
    renderEmpty(`${file.name} is selected. The app will read it when the review starts.`);
    return;
  }

  input.value = "";
  target.value = "";
  renderEmpty(`${file.name} is not supported here. Use TXT, CSV, JSON, MD, DOCX, XLSX, PDF, JPG, PNG, WEBP, or GIF.`, true);
}

function getExtension(name) {
  const dot = String(name || "").lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

function setBusy(isBusy) {
  progress.classList.toggle("hidden", !isBusy);
  form.querySelectorAll("button, input, textarea").forEach((element) => {
    element.disabled = isBusy;
  });
}

function updateRecordingStatus() {
  const files = [...(recordingInput.files || [])];
  if (!files.length) {
    recordingStatus.textContent = "No call recordings selected yet.";
    recordingStatus.classList.add("warning");
    return;
  }

  const totalMb = files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024;
  const names = files.map((file) => file.name).join(", ");
  recordingStatus.textContent = files.length === 1
    ? `Recording selected: ${names}, ${totalMb.toFixed(1)} MB`
    : `Recordings selected for one intake: ${files.length} files, ${totalMb.toFixed(1)} MB total. ${names}`;
  recordingStatus.classList.remove("warning");
  reportTitle.textContent = files.length === 1 ? "Recording selected" : "Recordings selected";
  renderEmpty("Add the completed intake form if it exists, or leave intake blank to review script/process only. Then click Review call.");
}

function updateUploadSummary() {
  const files = getSelectedFiles();
  if (!files.length) {
    uploadSummary.textContent = "Ready for files.";
    uploadSummary.classList.remove("warning");
    return;
  }

  const totalMb = files.reduce((sum, file) => sum + file.size, 0) / 1024 / 1024;
  const names = files.map((file) => file.name).join(", ");
  uploadSummary.textContent = `Selected files: ${files.length} file(s), ${totalMb.toFixed(1)} MB total. ${names}`;
  uploadSummary.classList.toggle("warning", totalMb > maxUploadMb);
}

function getSelectedFiles() {
  return uploadInputs.flatMap((name) => {
    const input = form.elements[name] || document.querySelector(`#${name}`);
    return input?.files?.length ? [...input.files] : [];
  });
}

function renderReport(payload) {
  latestReviewPayload = payload;
  const qa = payload.report;
  const hasIntake = payload.hasIntake !== false;
  const leadPhone = extractPhoneFromPayload(payload) || qa.leadPhoneNumber || "Not found";
  const tortType = payload.reviewType === "debt" ? "Debt" : normalizeTortType(payload.tortType) || "Unknown tort";
  const reportName = buildReportName(leadPhone, tortType);
  reportTitle.textContent = reportName;
  document.title = reportName;
  emptyState.classList.add("hidden");
  report.classList.remove("hidden");
  downloadReport.href = payload.reportUrl;
  downloadReport.classList.remove("hidden");
  latestKeyFindingsText = buildKeyFindingsText(payload);
  const findingsUrl = makeTextDownload(latestKeyFindingsText);

  const scoreCards = [
    ["Intake", hasIntake ? qa.intakeAccuracyScore : "N/A"],
    ["Script", qa.scriptAdherenceScore],
    ["Process", qa.processComplianceScore],
    ["Experience", qa.customerExperienceScore],
    ["Fraud risk", qa.fraudRiskScore ?? 0]
  ];

  report.innerHTML = `
    <section class="summary">
      <div class="verdict ${escapeHtml(qa.overallStatus)}">${labelStatus(qa.overallStatus)}</div>
      <p>${escapeHtml(qa.summary)}</p>
    </section>

    <section class="lead-details">
      <div>
        <span>Date of review</span>
        <strong>${escapeHtml(formatReviewDate(payload.createdAt))}</strong>
      </div>
      <div>
        <span>Lead phone</span>
        <strong>${escapeHtml(leadPhone)}</strong>
      </div>
      <div>
        <span>Tort reviewed</span>
        <input class="inline-edit" id="tortTypeOverride" value="${escapeHtml(tortType)}" aria-label="Tort reviewed">
      </div>
      <div>
        <span>Agent</span>
        <strong>${escapeHtml(qa.agentName || "Not found")}</strong>
      </div>
    </section>

    <section class="share-actions">
      <button class="secondary" type="button" id="printReport">Print report</button>
      <a class="download" id="keyFindingsDownload" href="${findingsUrl}" download="${safeDownloadName(reportName)}-key-findings.txt">Key findings TXT</a>
      <button class="secondary" type="button" id="copyKeyFindings">Copy key findings</button>
    </section>

    <section class="scores">
      ${scoreCards.map(([label, value]) => `
        <div class="score">
          <span>${label}</span>
          <strong>${formatScore(value)}</strong>
        </div>
      `).join("")}
    </section>

    ${renderIssueGroup("Key findings", qa.keyFindings)}
    ${renderIssueGroup("Recorded answer mismatches", qa.intakeMismatches)}
    ${renderIssueGroup("Missing information", qa.missingInformation)}
    ${renderIssueGroup("Off-script moments", qa.offScriptMoments)}
    ${renderIssueGroup("Process violations", qa.processViolations)}
    ${renderIssueGroup("Fraud risk indicators", qa.fraudRiskIndicators)}
    ${renderIssueGroup("Cross-case pattern warnings", qa.crossCasePatternWarnings)}
    ${renderList("Follow-up questions", qa.followUpQuestions)}
    ${renderList("Coaching notes", qa.coachingNotes)}

    <section class="group ask-review">
      <h3>Ask about this review</h3>
      <form id="askReviewForm" class="ask-form">
        <textarea id="reviewQuestion" class="short" placeholder="Example: Why was this marked needs review? Where did the lead confirm the diagnosis?"></textarea>
        <button class="secondary" type="submit">Ask</button>
      </form>
      <div id="reviewAnswer" class="answer-box hidden"></div>
    </section>

    <details class="transcript">
      <summary>Transcript</summary>
      <pre>${escapeHtml(payload.transcript.text || "")}</pre>
    </details>
  `;

  document.querySelector("#copyKeyFindings")?.addEventListener("click", copyKeyFindings);
  document.querySelector("#printReport")?.addEventListener("click", () => window.print());
  document.querySelector("#askReviewForm")?.addEventListener("submit", askAboutReview);
  document.querySelector("#tortTypeOverride")?.addEventListener("input", (event) => {
    const updatedTort = event.target.value.trim() || "Unknown tort";
    payload.tortType = updatedTort;
    const updatedReportName = buildReportName(leadPhone, updatedTort);
    reportTitle.textContent = updatedReportName;
    document.title = updatedReportName;
    latestKeyFindingsText = buildKeyFindingsText(payload);
    const link = document.querySelector("#keyFindingsDownload");
    if (link) {
      link.href = makeTextDownload(latestKeyFindingsText);
      link.download = `${safeDownloadName(updatedReportName)}-key-findings.txt`;
    }
  });
}

async function askAboutReview(event) {
  event.preventDefault();
  const questionInput = document.querySelector("#reviewQuestion");
  const answerBox = document.querySelector("#reviewAnswer");
  const button = event.currentTarget.querySelector("button");
  const question = questionInput?.value.trim();

  if (!question) {
    answerBox.textContent = "Type a question about this completed review first.";
    answerBox.classList.remove("hidden");
    answerBox.classList.add("error");
    return;
  }

  try {
    button.disabled = true;
    answerBox.textContent = "Checking this review...";
    answerBox.classList.remove("hidden", "error");
    const response = await fetchWithTimeout("/api/ask-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        review: latestReviewPayload
      })
    }, 120000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The question could not be answered.");
    answerBox.textContent = payload.answer || "No answer was returned.";
  } catch (error) {
    answerBox.textContent = error.message || "The question could not be answered.";
    answerBox.classList.add("error");
  } finally {
    button.disabled = false;
  }
}

async function reviewBatchPatterns(event) {
  event.preventDefault();
  const recordings = batchPatternForm.elements.batchRecordings.files || [];
  if (recordings.length < 2) {
    batchPatternStatus.textContent = "Choose at least two recordings to compare.";
    batchPatternStatus.classList.remove("hidden");
    batchPatternStatus.classList.add("error");
    return;
  }

  const totalMb = [...recordings].reduce((sum, file) => sum + file.size, 0) / 1024 / 1024;
  if (totalMb > maxUploadMb) {
    batchPatternStatus.textContent = `The selected recordings total ${totalMb.toFixed(1)} MB. The current app limit is ${maxUploadMb} MB.`;
    batchPatternStatus.classList.remove("hidden");
    batchPatternStatus.classList.add("error");
    return;
  }

  try {
    batchPatternForm.querySelectorAll("button, input, select, textarea").forEach((element) => {
      element.disabled = true;
    });
    batchPatternReport.classList.add("hidden");
    batchPatternStatus.textContent = `Uploading and comparing ${recordings.length} recordings. This can take several minutes.`;
    batchPatternStatus.classList.remove("hidden", "error");
    const response = await fetchWithTimeout("/api/batch-patterns", {
      method: "POST",
      body: new FormData(batchPatternForm)
    }, 900000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "The batch pattern review could not be completed.");
    batchPatternStatus.classList.add("hidden");
    renderBatchPatternReport(payload);
  } catch (error) {
    batchPatternStatus.textContent = error.message || "The batch pattern review could not be completed.";
    batchPatternStatus.classList.remove("hidden");
    batchPatternStatus.classList.add("error");
  } finally {
    batchPatternForm.querySelectorAll("button, input, select, textarea").forEach((element) => {
      element.disabled = false;
    });
  }
}

function renderBatchPatternReport(payload) {
  const batch = payload.report || {};
  batchPatternReport.classList.remove("hidden");
  batchPatternReport.innerHTML = `
    <section class="summary">
      <div class="verdict ${escapeHtml(batch.overallRiskLevel || "needs_review")}">${escapeHtml(labelRisk(batch.overallRiskLevel))}</div>
      <p>${escapeHtml(batch.summary || "Pattern review complete.")}</p>
    </section>

    <section class="lead-details">
      <div><span>Date</span><strong>${escapeHtml(formatReviewDate(payload.createdAt))}</strong></div>
      <div><span>Review type</span><strong>${escapeHtml(labelReviewType(payload.reviewType))}</strong></div>
      <div><span>Vendor/source</span><strong>${escapeHtml(payload.vendor || "Not supplied")}</strong></div>
      <div><span>Recordings</span><strong>${escapeHtml(String(payload.recordings?.length || 0))}</strong></div>
    </section>

    ${renderPatternGroup("Similarity patterns", batch.patterns)}
    ${renderPatternGroup("Vendor/source signals", batch.vendorSignals)}
    ${renderList("Recommended next steps", batch.recommendedNextSteps)}
    ${renderList("Calls needing individual review", batch.callsNeedingIndividualReview)}
  `;
}

function renderPatternGroup(title, patterns = []) {
  if (!patterns.length) return `<section class="group no-issues"><h3>${title}</h3><p class="quiet">No patterns found.</p></section>`;
  return `
    <section class="group">
      <h3>${title}</h3>
      <div class="issues">
        ${patterns.map((pattern) => `
          <article class="issue ${escapeHtml(pattern.severity)}">
            <div class="issue-title">
              <strong>${escapeHtml(pattern.title)}</strong>
              <span>${escapeHtml(pattern.severity)} - ${Math.round(Number(pattern.confidence || 0) * 100)}%</span>
            </div>
            <p>${escapeHtml(pattern.evidence)}</p>
            <dl>
              <dt>Calls</dt><dd>${escapeHtml((pattern.callsInvolved || []).join(", "))}</dd>
              <dt>Why</dt><dd>${escapeHtml(pattern.whyItMatters)}</dd>
              <dt>Follow-up</dt><dd>${escapeHtml(pattern.recommendedFollowUp)}</dd>
            </dl>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function labelRisk(value) {
  return {
    low: "Low risk",
    medium: "Medium risk",
    high: "High risk",
    critical: "Critical risk"
  }[value] || "Needs review";
}

function renderIssueGroup(title, issues = []) {
  if (!issues.length) return `<section class="group no-issues"><h3>${title}</h3><p class="quiet">No issues found.</p></section>`;
  return `
    <section class="group">
      <h3>${title}</h3>
      <div class="issues">
        ${issues.map((issue) => `
          <article class="issue ${escapeHtml(issue.severity)}">
            <div class="issue-title">
              <strong>${escapeHtml(issue.title)}</strong>
              <span>${escapeHtml(issue.severity)} - ${Math.round(Number(issue.confidence || 0) * 100)}%</span>
            </div>
            <p>${escapeHtml(issue.evidence)}</p>
            <dl>
              <dt>Reference</dt><dd>${escapeHtml(issue.transcriptReference)}</dd>
              <dt>Expected</dt><dd>${escapeHtml(issue.expected)}</dd>
              <dt>Fix</dt><dd>${escapeHtml(issue.recommendedFix)}</dd>
            </dl>
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderList(title, items = []) {
  if (!items.length) return "";
  return `
    <section class="group">
      <h3>${title}</h3>
      <ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>
    </section>
  `;
}

function renderError(message) {
  report.classList.add("hidden");
  downloadReport.classList.add("hidden");
  reportTitle.textContent = "Review stopped";
  renderEmpty(message, true);
}

async function copyKeyFindings() {
  try {
    await navigator.clipboard.writeText(latestKeyFindingsText);
    reportTitle.textContent = "Key findings copied";
  } catch {
    renderEmpty("Could not copy automatically. Use the Key findings TXT button instead.", true);
  }
}

function buildKeyFindingsText(payload) {
  const qa = payload.report;
  const hasIntake = payload.hasIntake !== false;
  const leadPhone = extractPhoneFromPayload(payload) || qa.leadPhoneNumber || "Not found";
  const tortType = payload.reviewType === "debt" ? "Debt" : normalizeTortType(payload.tortType) || "Unknown tort";
  const sections = [
    `Call QA Key Findings`,
    `Case: ${buildReportName(leadPhone, tortType)}`,
    `Lead phone: ${leadPhone}`,
    `Tort reviewed: ${tortType}`,
    `Agent: ${qa.agentName || "Not found"}`,
    `Created: ${new Date(payload.createdAt || Date.now()).toLocaleString()}`,
    `Overall status: ${labelStatus(qa.overallStatus)}`,
    "",
    `Summary: ${qa.summary}`,
    "",
    `Scores`,
    `- Intake: ${hasIntake ? qa.intakeAccuracyScore : "N/A"}`,
    `- Script: ${qa.scriptAdherenceScore}`,
    `- Process: ${qa.processComplianceScore}`,
    `- Experience: ${qa.customerExperienceScore}`,
    `- Fraud risk: ${qa.fraudRiskScore ?? 0}`,
    "",
    formatIssueText("Key findings", qa.keyFindings),
    formatIssueText("Recorded answer mismatches", qa.intakeMismatches),
    formatIssueText("Missing information", qa.missingInformation),
    formatIssueText("Off-script moments", qa.offScriptMoments),
    formatIssueText("Process violations", qa.processViolations),
    formatIssueText("Fraud risk indicators", qa.fraudRiskIndicators),
    formatIssueText("Cross-case pattern warnings", qa.crossCasePatternWarnings),
    formatSimpleListText("Follow-up questions", qa.followUpQuestions),
    formatSimpleListText("Coaching notes", qa.coachingNotes)
  ];
  return sections.filter(Boolean).join("\n");
}

function formatScore(value) {
  return value === "N/A" ? "N/A" : Number(value || 0);
}

function formatReviewDate(value) {
  return new Date(value || Date.now()).toLocaleDateString();
}

function extractPhoneFromFilename(name) {
  const groups = String(name || "").match(/\d+/g) || [];
  const candidates = groups
    .filter((group) => group.length >= 10)
    .map((group) => group.slice(-10));
  const phone = candidates.at(-1);
  if (!phone) return "";
  return `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`;
}

function extractPhoneFromPayload(payload) {
  const fromRecording = (payload.recordings || [])
    .map((recording) => recording.leadPhoneNumber || extractPhoneFromFilename(recording.filename))
    .find(Boolean);
  return fromRecording || extractPhoneFromFilename(payload.originalRecording);
}

function buildReportName(phone, tortType) {
  return `${phone || "No phone"} - ${tortType || "Unknown tort"}`;
}

function normalizeTortType(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/\bdepo\b/i.test(text) && /birth\s+control|shot|depo[-\s]?provera/i.test(text)) {
    return "Depo Birth Control";
  }
  if (/\b(roundup|weed killer|glyphosate)\b/i.test(text)) {
    return "Roundup";
  }
  if (/\b(sensitivity of this claim|attorneys? will|attorney|law firm|get a hold of you|contact you|promptly|phone|email|address)\b/i.test(text)) {
    return "Unknown tort";
  }
  if (text.length > 55 || /[?]/.test(text) || /,\s+\w+/.test(text)) {
    return "Unknown tort";
  }
  return text.slice(0, 55);
}

function formatIssueText(title, issues = []) {
  if (!issues.length) return `${title}\n- No issues found.\n`;
  const lines = [`${title}`];
  issues.forEach((issue, index) => {
    lines.push(`${index + 1}. ${issue.title} (${issue.severity}, ${Math.round(Number(issue.confidence || 0) * 100)}% confidence)`);
    lines.push(`   Evidence: ${issue.evidence}`);
    lines.push(`   Reference: ${issue.transcriptReference}`);
    lines.push(`   Expected: ${issue.expected}`);
    lines.push(`   Recommended fix: ${issue.recommendedFix}`);
  });
  lines.push("");
  return lines.join("\n");
}

function formatSimpleListText(title, items = []) {
  if (!items.length) return "";
  return `${title}\n${items.map((item) => `- ${item}`).join("\n")}\n`;
}

function makeTextDownload(text) {
  return URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
}

function safeDownloadName(name) {
  return String(name || "call-review")
    .trim()
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "call-review";
}

function renderEmpty(message, isError = false) {
  emptyState.textContent = message;
  emptyState.classList.remove("hidden");
  emptyState.classList.toggle("error", isError);
}

function labelStatus(status) {
  return {
    pass: "Pass",
    needs_review: "Needs review",
    fail: "Fail"
  }[status] || "Needs review";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
