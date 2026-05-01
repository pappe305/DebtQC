import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const PORT = Number(process.env.PORT || 4377);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const QA_MODEL = process.env.OPENAI_QA_MODEL || "gpt-5.4-mini";
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 200);
const MAX_BODY_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const JSZip = await loadOptionalPackage("jszip");

const dataDir = path.join(__dirname, "data");
const uploadDir = path.join(dataDir, "uploads");
const reportDir = path.join(dataDir, "reports");
const defaultsPath = path.join(dataDir, "defaults.json");
const logPath = path.join(dataDir, "server.log");

await fs.mkdir(uploadDir, { recursive: true });
await fs.mkdir(reportDir, { recursive: true });

process.on("uncaughtException", (error) => {
  void writeLog(`uncaughtException: ${error.stack || error.message}`);
});

process.on("unhandledRejection", (error) => {
  void writeLog(`unhandledRejection: ${error?.stack || error}`);
});

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = http.createServer(async (req, res) => {
  try {
    const requestPath = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;

    if (req.method === "GET" && requestPath === "/api/health") {
      return sendJson(res, 200, {
        ok: true,
        hasApiKey: Boolean(OPENAI_API_KEY),
        transcriptionModel: TRANSCRIPTION_MODEL,
        qaModel: QA_MODEL
      });
    }

    if (req.method === "GET" && requestPath === "/api/defaults") {
      return sendJson(res, 200, await readDefaults());
    }

    if (req.method === "POST" && requestPath === "/api/defaults") {
      const payload = JSON.parse((await readRequestBody(req)).toString("utf8") || "{}");
      const saved = await saveDefaults(payload);
      return sendJson(res, 200, saved);
    }

    if (req.method === "POST" && requestPath === "/api/analyze") {
      return await handleAnalyze(req, res);
    }

    if (req.method === "GET" && requestPath.startsWith("/reports/")) {
      const name = decodeURIComponent(requestPath.replace("/reports/", ""));
      const safeName = path.basename(name);
      return serveFile(res, path.join(reportDir, safeName), "application/json; charset=utf-8");
    }

    const publicRoot = path.join(__dirname, "public");
    const rootStaticFiles = new Map([
      ["/", "index.html"],
      ["/index.html", "index.html"],
      ["/app.js", "app.js"],
      ["/styles.css", "styles.css"]
    ]);
    const requestedPath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
    const safePath = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
    const publicFilePath = path.join(publicRoot, safePath);
    const rootFilePath = rootStaticFiles.has(requestPath)
      ? path.join(__dirname, rootStaticFiles.get(requestPath))
      : null;

    if (publicFilePath.startsWith(publicRoot)) {
      try {
        await fs.access(publicFilePath);
        return serveFile(res, publicFilePath);
      } catch {
        // Fall back to root-level static files for simple GitHub uploads.
      }
    }

    if (rootFilePath) {
      return serveFile(res, rootFilePath);
    }

    if (!publicFilePath.startsWith(publicRoot)) {
      return sendText(res, 403, "Forbidden");
    }
    return serveFile(res, publicFilePath);
  } catch (error) {
    console.error(error);
    return sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Call QA Reviewer is running at http://localhost:${PORT}`);
});

async function handleAnalyze(req, res) {
  try {
    await writeLog("Review request started");
    if (!OPENAI_API_KEY || OPENAI_API_KEY === "your_api_key_here") {
      await writeLog("Review stopped: missing or placeholder API key");
      return sendJson(res, 400, {
        error: "OPENAI_API_KEY is missing or still set to the placeholder. Set your real OpenAI API key, then restart the app."
      });
    }

    const body = await readRequestBody(req);
    await writeLog(`Upload received: ${(body.length / 1024 / 1024).toFixed(2)} MB`);
    const contentType = req.headers["content-type"] || "";
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[1] || contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i)?.[2];
    if (!boundary) {
      return sendJson(res, 400, { error: "Expected a multipart form upload." });
    }

    const parts = parseMultipart(body, boundary);
    const getField = (name) => parts.find((part) => part.name === name && !part.filename)?.data.toString("utf8").trim() || "";
    const getUploadedText = async (name) => {
      const part = parts.find((item) => item.name === name && item.filename && item.data?.length);
      return part ? await extractTextFromUpload(part) : "";
    };
    const audioPart = parts.find((part) => part.name === "recording" && part.filename);
    await writeLog(`Parts: ${parts.map((part) => `${part.name}${part.filename ? `=${part.filename}` : ""}`).join(", ")}`);

    if (!audioPart?.data?.length) {
      await writeLog("Review stopped: no recording part");
      return sendJson(res, 400, { error: "Please choose a call recording." });
    }

    const caseName = getField("caseName") || "Untitled call";
    const intake = getField("intake") || await getUploadedText("intakeFile");
    const defaults = await readDefaults();
    const script = getField("script") || await getUploadedText("scriptFile") || defaults.script;
    const process = getField("process") || await getUploadedText("processFile") || defaults.process;
    const reviewerFocus = getField("reviewerFocus");
    await writeLog(`Text ready: intake=${intake.length}, script=${script.length}, process=${process.length}`);

    const jobId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID().slice(0, 8)}`;
    const originalName = sanitizeFilename(audioPart.filename || "recording");
    const leadPhoneFromRecording = extractPhoneFromFilename(originalName);
    const tortType = extractTortTypeFromIntake(intake);
    const uploadPath = path.join(uploadDir, `${jobId}-${originalName}`);
    await fs.writeFile(uploadPath, audioPart.data);
    await writeLog(`Recording saved: ${originalName}`);

    const transcript = await transcribeRecording(audioPart);
    await writeLog(`Transcription complete: ${transcript.text.length} chars`);
    const report = await reviewCall({
      caseName,
      intake,
      script,
      process,
      reviewerFocus,
      transcript
    });
    if (leadPhoneFromRecording) {
      report.leadPhoneNumber = leadPhoneFromRecording;
    }
    const patternWarnings = await detectCrossCasePatternWarnings({
      currentId: jobId,
      report,
      intake,
      transcript,
      tortType,
      originalRecording: originalName
    });
    report.crossCasePatternWarnings = [
      ...(Array.isArray(report.crossCasePatternWarnings) ? report.crossCasePatternWarnings : []),
      ...patternWarnings
    ];
    if (patternWarnings.length) {
      report.overallStatus = report.overallStatus === "pass" ? "needs_review" : report.overallStatus;
      report.fraudRiskScore = Math.max(Number(report.fraudRiskScore || 0), Math.min(100, 55 + patternWarnings.length * 15));
    }

    const saved = {
      id: jobId,
      createdAt: new Date().toISOString(),
      caseName,
      hasIntake: Boolean(intake),
      tortType,
      originalRecording: originalName,
      models: {
        transcription: transcript.model || TRANSCRIPTION_MODEL,
        qa: QA_MODEL
      },
      transcript,
      report
    };

    const reportName = `${jobId}.json`;
    await fs.writeFile(path.join(reportDir, reportName), JSON.stringify(saved, null, 2), "utf8");
    await writeLog(`Review complete: ${reportName}`);
    return sendJson(res, 200, { ...saved, reportUrl: `/reports/${encodeURIComponent(reportName)}` });
  } catch (error) {
    await writeLog(`Review failed: ${error.stack || error.message}`);
    return sendJson(res, 500, { error: error.message || "The review failed." });
  }
}

async function extractTextFromUpload(part) {
  const filename = part.filename || "uploaded file";
  const ext = path.extname(filename).toLowerCase();

  if ([".txt", ".csv", ".json", ".md", ".log"].includes(ext)) {
    return part.data.toString("utf8").trim();
  }

  if (ext === ".docx") {
    return extractDocxText(part.data, filename);
  }

  if (ext === ".xlsx") {
    return extractXlsxText(part.data, filename);
  }

  if (ext === ".pdf") {
    return extractTextWithOpenAI(part, "PDF document");
  }

  if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) {
    return extractTextWithOpenAI(part, "image");
  }

  if (ext === ".doc") {
    throw new Error(`${filename} is an older Word .doc file. Open it in Word and save it as .docx, then load it again.`);
  }

  if (ext === ".xls") {
    throw new Error(`${filename} is an older Excel .xls file. Save it as .xlsx or CSV, then load it again.`);
  }

  throw new Error(`${filename} is not supported for intake/script/process text. Use TXT, CSV, JSON, MD, DOCX, XLSX, PDF, JPG, PNG, WEBP, or GIF.`);
}

async function extractTextWithOpenAI(part, label) {
  if (!OPENAI_API_KEY) {
    throw new Error(`${part.filename} needs text extraction, but OPENAI_API_KEY is not set.`);
  }

  const filename = part.filename || "uploaded file";
  const ext = path.extname(filename).toLowerCase();
  const content = [
    {
      type: "input_text",
      text: `Extract all readable text from this ${label}. Preserve headings, lists, tables, field names, and field values. Return only the extracted text.`
    }
  ];

  if (ext === ".pdf") {
    const mime = part.contentType || "application/pdf";
    content.push({
      type: "input_file",
      filename,
      file_data: `data:${mime};base64,${part.data.toString("base64")}`
    });
  } else {
    const mime = part.contentType || imageMimeType(ext);
    content.push({
      type: "input_image",
      image_url: `data:${mime};base64,${part.data.toString("base64")}`,
      detail: "high"
    });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: QA_MODEL,
      input: [
        {
          role: "user",
          content
        }
      ]
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `Could not read text from ${filename}.`);
  }

  const text = extractOutputText(payload).trim();
  if (!text) {
    throw new Error(`${filename} did not contain readable text.`);
  }
  return text;
}

function imageMimeType(ext) {
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif"
  }[ext] || "image/jpeg";
}

async function extractDocxText(buffer, filename) {
  if (!JSZip) {
    throw new Error(`${filename} needs DOCX support, but the local ZIP reader is not available. Save it as TXT or CSV.`);
  }

  const zip = await JSZip.loadAsync(buffer);
  const documentXml = await zip.file("word/document.xml")?.async("string");
  if (!documentXml) {
    throw new Error(`${filename} does not look like a readable DOCX file.`);
  }

  return xmlText(documentXml)
    .replace(/\s*\n\s*/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function extractXlsxText(buffer, filename) {
  if (!JSZip) {
    throw new Error(`${filename} needs XLSX support, but the local ZIP reader is not available. Save it as CSV.`);
  }

  const zip = await JSZip.loadAsync(buffer);
  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  if (!workbookXml) {
    throw new Error(`${filename} does not look like a readable XLSX file.`);
  }

  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const sharedStrings = sharedStringsXml ? [...sharedStringsXml.matchAll(/<si[\s\S]*?<\/si>/g)].map((match) => xmlText(match[0])) : [];
  const sheetFiles = Object.keys(zip.files)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

  const sheets = [];
  for (const sheetFile of sheetFiles) {
    const sheetXml = await zip.file(sheetFile)?.async("string");
    if (!sheetXml) continue;
    const rows = [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((rowMatch) => {
      const cells = [...rowMatch[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)].map((cellMatch) => {
        const attrs = cellMatch[1];
        const body = cellMatch[2];
        const value = body.match(/<v[^>]*>([\s\S]*?)<\/v>/)?.[1] || "";
        if (attrs.includes('t="s"')) return sharedStrings[Number(value)] || "";
        if (attrs.includes('t="inlineStr"')) return xmlText(body);
        return decodeXml(value);
      });
      return cells.map((cell) => cell.trim()).filter(Boolean).join(" | ");
    }).filter(Boolean);

    if (rows.length) sheets.push(`${path.basename(sheetFile, ".xml")}\n${rows.join("\n")}`);
  }

  const text = sheets.join("\n\n").trim();
  if (!text) {
    throw new Error(`${filename} did not contain readable worksheet text.`);
  }
  return text;
}

function xmlText(xml) {
  return decodeXml(
    xml
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:tc>/g, " | ")
      .replace(/<[^>]+>/g, " ")
  );
}

function decodeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadOptionalPackage(name) {
  const candidates = [
    name,
    path.join(process.env.USERPROFILE || "", ".cache", "codex-runtimes", "codex-primary-runtime", "dependencies", "node", "node_modules", name)
  ];

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      try {
        const module = await import(pathToFileURL(candidate).href);
        return module.default || module;
      } catch {
        // Optional dependency. The app falls back to clearer file-type errors.
      }
    }
  }
  return null;
}

async function readDefaults() {
  try {
    const text = await fs.readFile(defaultsPath, "utf8");
    const parsed = JSON.parse(text);
    return {
      script: String(parsed.script || ""),
      process: String(parsed.process || "")
    };
  } catch {
    return { script: "", process: "" };
  }
}

async function saveDefaults(payload) {
  const defaults = {
    script: String(payload.script || ""),
    process: String(payload.process || "")
  };
  await fs.writeFile(defaultsPath, JSON.stringify(defaults, null, 2), "utf8");
  return defaults;
}

async function transcribeRecording(audioPart) {
  const models = TRANSCRIPTION_MODEL === "whisper-1"
    ? ["whisper-1"]
    : [TRANSCRIPTION_MODEL, "whisper-1"];
  let lastError = null;

  for (const model of models) {
    try {
      await writeLog(`Transcription attempt: ${model}`);
      const transcript = await transcribeWithModel(audioPart, model);
      transcript.model = model;
      return transcript;
    } catch (error) {
      lastError = error;
      await writeLog(`Transcription failed with ${model}: ${error.message}`);
      const canRetry = /too large|tokens|token/i.test(error.message) && model !== "whisper-1";
      if (!canRetry) break;
    }
  }

  throw lastError || new Error("Transcription failed.");
}

async function transcribeWithModel(audioPart, model) {
  const form = new FormData();
  const blob = new Blob([audioPart.data], { type: audioPart.contentType || "application/octet-stream" });
  form.append("file", blob, audioPart.filename || "recording");
  form.append("model", model);
  form.append("response_format", "json");
  if (model.includes("diarize")) {
    form.append("chunking_strategy", JSON.stringify({ type: "auto" }));
  }

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: form
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `Transcription failed with status ${response.status}`);
  }

  return normalizeTranscript(payload);
}

async function reviewCall({ caseName, intake, script, process, reviewerFocus, transcript }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: QA_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: [
                "You are a meticulous call quality auditor.",
                "This app may be used for Mass Tort Claims intake calls where the completed intake form is also the call script.",
                "When intake notes or an intake form are supplied, treat every populated intake answer as a recorded field that must be verified against what the caller actually said in the transcript.",
                "For checkbox, dropdown, radio button, yes/no, and multi-select fields, verify that the selected option is exactly the option supported by the lead's answer.",
                "If the lead says a different diagnosis, injury, product, exposure, date, provider, treatment location, consent answer, or eligibility answer than the selected intake option, flag it as a high-severity intake_error.",
                "For example, if the lead says brain cancer but the form selected brain tumor, or vice versa, that is a recorded answer mismatch unless the transcript clearly supports both.",
                "For each populated intake answer, determine whether the transcript supports it, contradicts it, or does not contain enough evidence.",
                "Put incorrect, contradicted, unsupported, or materially incomplete recorded answers in intakeMismatches with the recorded answer, caller-supported answer, and transcript evidence.",
                "Use missingInformation for required intake/script questions that were not asked, not answered, or not captured clearly.",
                "Do not assume a populated intake answer is correct merely because it appears in the form; require transcript support.",
                "If the intake form includes eligibility, exposure, injury, medication/product, date, provider, diagnosis, claimant identity, contact, representation, or consent fields, verify them field by field.",
                "If separate approved script or internal process rules are supplied, also review script adherence and process compliance.",
                "If no intake notes are supplied, run a script and process compliance review only.",
                "When no intake notes are supplied, do not create intake mismatch findings solely because the intake is absent.",
                "In that no-intake mode, use missingInformation for required call fields or required process steps that were not captured or not asked during the call.",
                "Also look for fraud risk indicators, but do not accuse anyone of fraud or state that fraud occurred.",
                "Use fraudRiskIndicators for suspicious patterns that need human review: coached or scripted-sounding lead answers, a third party telling the lead what to say, agent leading or stretching answers to qualify the claimant, inconsistent exposure/injury/timeline facts, generic or memorized provider details, refusal or inability to provide ordinary details, paid-lead language, duplicate-looking identity/contact details, or claim facts that seem tailored only to eligibility.",
                "For Roundup or similar exposure cases, flag addresses that appear to be apartment complexes, large shared properties, generic work sites, or locations where personal product use would be unusual unless the transcript clearly explains the exposure.",
                "For hospital, provider, residence, exposure, employment, or injury-location fields, flag exact repeated-looking addresses or unusually generic facility details as risk indicators if supported by the call or intake.",
                "Extract the lead phone number and agent name from the intake notes or transcript when present.",
                "If either value is not clearly present, return an empty string for that field.",
                "Flag only issues supported by the supplied materials. If evidence is uncertain, mark confidence below 0.7.",
                "Do not invent policies. If no script or process is supplied, say that review area could not be fully assessed.",
                "Use concise, plain-language explanations suitable for operations managers."
              ].join(" ")
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Case name: ${caseName}`,
                `Tort type from intake question 1: ${extractTortTypeFromIntake(intake) || "(not found)"}`,
                "",
                "COMPLETED INTAKE FORM / RECORDED ANSWERS TO VERIFY:",
                intake || "(none supplied)",
                "",
                "SEPARATE APPROVED CALL SCRIPT, IF ANY:",
                script || "(none supplied)",
                "",
                "INTERNAL PROCESS RULES:",
                process || "(none supplied)",
                "",
                "REVIEWER FOCUS:",
                reviewerFocus || "(standard call QA review)",
                "",
                "CALL TRANSCRIPT:",
                transcript.text,
                transcript.segments?.length ? `\nTIMED SEGMENTS:\n${formatSegments(transcript.segments)}` : ""
              ].join("\n")
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "call_qa_report",
          strict: true,
          schema: reportSchema()
        }
      }
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error?.message || `QA review failed with status ${response.status}`);
  }

  const outputText = extractOutputText(payload);
  if (!outputText) {
    throw new Error("QA review completed but did not return a report.");
  }
  return JSON.parse(outputText);
}

function normalizeTranscript(payload) {
  const segments = Array.isArray(payload.segments)
    ? payload.segments.map((segment) => ({
        start: asNumberOrNull(segment.start),
        end: asNumberOrNull(segment.end),
        speaker: segment.speaker || segment.label || null,
        text: String(segment.text || "").trim()
      })).filter((segment) => segment.text)
    : [];

  return {
    text: String(payload.text || segments.map((segment) => `${segment.speaker ? `${segment.speaker}: ` : ""}${segment.text}`).join("\n")).trim(),
    language: payload.language || null,
    duration: asNumberOrNull(payload.duration),
    segments,
    raw: payload
  };
}

function reportSchema() {
  const issue = {
    type: "object",
    additionalProperties: false,
    properties: {
      title: { type: "string" },
      severity: { type: "string", enum: ["critical", "high", "medium", "low"] },
      category: { type: "string", enum: ["intake_error", "missing_information", "off_script", "process_violation", "customer_risk", "fraud_risk", "other"] },
      evidence: { type: "string" },
      transcriptReference: { type: "string" },
      expected: { type: "string" },
      recommendedFix: { type: "string" },
      confidence: { type: "number" }
    },
    required: ["title", "severity", "category", "evidence", "transcriptReference", "expected", "recommendedFix", "confidence"]
  };

  return {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: { type: "string" },
      leadPhoneNumber: { type: "string" },
      agentName: { type: "string" },
      overallStatus: { type: "string", enum: ["pass", "needs_review", "fail"] },
      intakeAccuracyScore: { type: "integer" },
      scriptAdherenceScore: { type: "integer" },
      processComplianceScore: { type: "integer" },
      customerExperienceScore: { type: "integer" },
      fraudRiskScore: { type: "integer" },
      keyFindings: {
        type: "array",
        items: issue
      },
      intakeMismatches: {
        type: "array",
        items: issue
      },
      missingInformation: {
        type: "array",
        items: issue
      },
      offScriptMoments: {
        type: "array",
        items: issue
      },
      processViolations: {
        type: "array",
        items: issue
      },
      fraudRiskIndicators: {
        type: "array",
        items: issue
      },
      crossCasePatternWarnings: {
        type: "array",
        items: issue
      },
      followUpQuestions: {
        type: "array",
        items: { type: "string" }
      },
      coachingNotes: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: [
      "summary",
      "leadPhoneNumber",
      "agentName",
      "overallStatus",
      "intakeAccuracyScore",
      "scriptAdherenceScore",
      "processComplianceScore",
      "customerExperienceScore",
      "fraudRiskScore",
      "keyFindings",
      "intakeMismatches",
      "missingInformation",
      "offScriptMoments",
      "processViolations",
      "fraudRiskIndicators",
      "crossCasePatternWarnings",
      "followUpQuestions",
      "coachingNotes"
    ]
  };
}

function extractOutputText(payload) {
  if (payload.output_text) return payload.output_text;
  const chunks = [];
  for (const item of payload.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
      if (content.type === "text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("").trim();
}

function formatSegments(segments) {
  return segments
    .slice(0, 900)
    .map((segment) => {
      const time = segment.start !== null ? `[${formatTime(segment.start)}${segment.end !== null ? `-${formatTime(segment.end)}` : ""}] ` : "";
      const speaker = segment.speaker ? `${segment.speaker}: ` : "";
      return `${time}${speaker}${segment.text}`;
    })
    .join("\n");
}

function formatTime(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const mins = Math.floor(whole / 60);
  const secs = String(whole % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

function parseMultipart(buffer, boundary) {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts = [];
  let position = buffer.indexOf(delimiter);

  while (position !== -1) {
    const next = buffer.indexOf(delimiter, position + delimiter.length);
    if (next === -1) break;

    let part = buffer.subarray(position + delimiter.length, next);
    if (part.subarray(0, 2).toString() === "\r\n") part = part.subarray(2);
    if (part.subarray(part.length - 2).toString() === "\r\n") part = part.subarray(0, part.length - 2);
    if (part.length && part.toString("utf8", 0, 2) !== "--") {
      const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
      if (headerEnd !== -1) {
        const headerText = part.subarray(0, headerEnd).toString("utf8");
        const data = part.subarray(headerEnd + 4);
        const disposition = headerText.match(/content-disposition:\s*form-data;([^\r\n]+)/i)?.[1] || "";
        const name = disposition.match(/name="([^"]+)"/i)?.[1];
        const filename = disposition.match(/filename="([^"]*)"/i)?.[1];
        const contentType = headerText.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim();
        if (name) parts.push({ name, filename, contentType, data });
      }
    }
    position = next;
  }

  return parts;
}

async function readRequestBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`Upload is too large. The current limit is ${MAX_UPLOAD_MB} MB.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveFile(res, filePath, forcedContentType) {
  try {
    const data = await fs.readFile(filePath);
    const type = forcedContentType || mimeTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sanitizeFilename(name) {
  return path.basename(name).replace(/[^a-z0-9_. -]/gi, "_").slice(0, 160);
}

function extractPhoneFromFilename(name) {
  const groups = String(name || "").match(/\d+/g) || [];
  const candidates = groups.flatMap((group) => {
    if (group.length < 10) return [];
    return [group.slice(-10)];
  });
  const phone = candidates.at(-1);
  if (!phone) return "";
  return `(${phone.slice(0, 3)}) ${phone.slice(3, 6)}-${phone.slice(6)}`;
}

function extractTortTypeFromIntake(intake) {
  const text = String(intake || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!text) return "";

  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/(^|\b)(question\s*)?1[\).:\-\s]/i.test(line) && !/\bq\.?\s*1\b/i.test(line)) continue;

    const sameLineValue = valueAfterQuestionMarker(line);
    if (sameLineValue) return cleanTortType(sameLineValue);

    for (const nextLine of lines.slice(index + 1, index + 5)) {
      const cleaned = cleanTortType(nextLine);
      if (cleaned && !/^question\s*\d+/i.test(cleaned)) return cleaned;
    }
  }

  const tortLine = lines.find((line) => /\b(tort|claim|campaign|case type|matter type)\b/i.test(line));
  if (tortLine) {
    const value = tortLine.split(/[:\-]/).slice(1).join("-").trim();
    if (value) return cleanTortType(value);
  }

  return "";
}

function valueAfterQuestionMarker(line) {
  return line
    .replace(/^\s*(question\s*)?1[\).:\-\s]+/i, "")
    .replace(/^\s*q\.?\s*1[\).:\-\s]+/i, "")
    .replace(/^(type\s+of\s+)?(tort|claim|case|matter)(\s+reviewed)?\s*[:\-]\s*/i, "")
    .trim();
}

function cleanTortType(value) {
  const cleaned = String(value || "")
    .replace(/^(answer|response|value|selected|type\s+of\s+tort|tort|claim|case\s+type)\s*[:\-]\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/^["']|["']$/g, "")
    .trim()
    .slice(0, 80);
  return normalizeTortType(cleaned);
}

function normalizeTortType(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/\bdepo\b/i.test(text) && /birth\s+control|shot|depo[-\s]?provera/i.test(text)) {
    return "Depo Birth Control";
  }
  return text;
}

async function detectCrossCasePatternWarnings({ currentId, report, intake, transcript, tortType, originalRecording }) {
  const warnings = [];
  const currentPhone = report.leadPhoneNumber || extractPhoneFromFilename(originalRecording);
  const currentTort = normalizeComparable(tortType || "");
  const currentText = [intake, transcript?.text, report?.summary].filter(Boolean).join("\n");
  const currentAddresses = extractAddresses(currentText);

  if (looksLikeRoundup(tortType, currentText) && hasApartmentExposureRisk(currentText)) {
    warnings.push(makeRiskIssue({
      title: "Roundup exposure address may be a shared residential property",
      severity: "medium",
      evidence: "The review materials mention Roundup or weed killer along with apartment, unit, complex, or similar shared-property wording near exposure/location language.",
      reference: findSnippet(currentText, /(roundup|weed killer|apartment|apartments|apt|unit|complex|address|applied|spray)/i),
      expected: "Confirm the exact exposure location and whether the claimant personally used or was exposed to the product there.",
      fix: "Have a reviewer verify the exposure address and ask follow-up questions before accepting eligibility."
    }));
  }

  if (!currentPhone && !currentAddresses.length) return warnings;

  const previousReports = await readRecentReports(currentId, 150);
  const repeatedAddresses = new Map();
  let repeatedPhone = null;

  for (const previous of previousReports) {
    const previousReport = previous.report || {};
    const previousPhone = previousReport.leadPhoneNumber || extractPhoneFromFilename(previous.originalRecording);
    const previousTort = normalizeComparable(previous.tortType || "");
    const sameTort = currentTort && previousTort && currentTort === previousTort;
    const previousLabel = `${previous.caseName || previous.originalRecording || previous.id || "prior review"}${previous.createdAt ? ` (${new Date(previous.createdAt).toLocaleDateString("en-US")})` : ""}`;

    if (currentPhone && previousPhone && normalizePhone(currentPhone) === normalizePhone(previousPhone)) {
      repeatedPhone = previousLabel;
    }

    const previousText = [
      previousReport.summary,
      previous.transcript?.text,
      ...(previousReport.keyFindings || []).map(issueToSearchText),
      ...(previousReport.intakeMismatches || []).map(issueToSearchText),
      ...(previousReport.fraudRiskIndicators || []).map(issueToSearchText)
    ].filter(Boolean).join("\n");
    const previousAddresses = extractAddresses(previousText);

    for (const address of currentAddresses) {
      if (!previousAddresses.includes(address)) continue;
      const count = repeatedAddresses.get(address) || { address, labels: [], sameTort: false };
      count.labels.push(previousLabel);
      count.sameTort ||= sameTort;
      repeatedAddresses.set(address, count);
    }
  }

  if (repeatedPhone) {
    warnings.push(makeRiskIssue({
      title: "Lead phone number appeared in a prior review",
      severity: "medium",
      evidence: `This phone number also appears in ${repeatedPhone}. This may be legitimate, but repeated claimant contact details should be checked.`,
      reference: currentPhone,
      expected: "Confirm whether this is the same claimant, a duplicate intake, or a shared/incorrect phone number.",
      fix: "Compare the prior review before approving the intake."
    }));
  }

  for (const item of repeatedAddresses.values()) {
    const labels = [...new Set(item.labels)].slice(0, 4).join("; ");
    warnings.push(makeRiskIssue({
      title: item.sameTort ? "Same address repeated in the same tort" : "Same address repeated in prior reviews",
      severity: item.sameTort ? "high" : "medium",
      evidence: `The address "${item.address}" also appears in prior saved review(s): ${labels}. Shared addresses can be normal, but exact repeats are a known pattern worth checking.`,
      reference: item.address,
      expected: "Confirm whether the address is genuinely tied to this claimant and claim facts.",
      fix: "Review the earlier case details and look for matching scripted answers, providers, exposure locations, or claimant relationships."
    }));
  }

  return warnings.slice(0, 8);
}

async function readRecentReports(currentId, limit) {
  try {
    const entries = await fs.readdir(reportDir, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && !entry.name.startsWith(currentId))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(0, limit);

    const reports = [];
    for (const file of files) {
      try {
        reports.push(JSON.parse(await fs.readFile(path.join(reportDir, file), "utf8")));
      } catch {
        // Skip unreadable older reports.
      }
    }
    return reports;
  } catch {
    return [];
  }
}

function extractAddresses(text) {
  const addressPattern = /\b\d{2,6}\s+[A-Za-z0-9.'#& -]{2,70}\s+(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|circle|cir|place|pl|way|terrace|ter|parkway|pkwy|highway|hwy)\b(?:\s+(?:apt|apartment|unit|suite|ste|#)\s*[A-Za-z0-9-]+)?/gi;
  const matches = String(text || "").match(addressPattern) || [];
  return [...new Set(matches.map(normalizeAddress).filter((address) => address.length >= 8))];
}

function normalizeAddress(address) {
  return String(address || "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(street)\b/g, "st")
    .replace(/\b(avenue)\b/g, "ave")
    .replace(/\b(road)\b/g, "rd")
    .replace(/\b(drive)\b/g, "dr")
    .replace(/\b(boulevard)\b/g, "blvd")
    .replace(/\b(lane)\b/g, "ln")
    .replace(/\b(court)\b/g, "ct")
    .replace(/\b(circle)\b/g, "cir")
    .replace(/\b(place)\b/g, "pl")
    .replace(/\b(terrace)\b/g, "ter")
    .replace(/\b(parkway)\b/g, "pkwy")
    .replace(/\b(highway)\b/g, "hwy")
    .replace(/\s+/g, " ")
    .trim();
}

function hasApartmentExposureRisk(text) {
  const source = String(text || "");
  const sharedProperty = /\b(apartment|apartments|apt\.?|unit|complex|building|condo|townhome|multi[-\s]?family)\b/i;
  const exposureWords = /\b(roundup|weed killer|spray|sprayed|applied|application|exposure|yard|lawn|garden|address|property|residence|where)\b/i;
  return sharedProperty.test(source) && exposureWords.test(source);
}

function looksLikeRoundup(tortType, text) {
  return /\b(roundup|weed killer|glyphosate)\b/i.test(`${tortType || ""}\n${text || ""}`);
}

function normalizeComparable(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "").slice(-10);
}

function issueToSearchText(issue) {
  return [issue?.title, issue?.evidence, issue?.transcriptReference, issue?.expected].filter(Boolean).join(" ");
}

function makeRiskIssue({ title, severity, evidence, reference, expected, fix }) {
  return {
    title,
    severity,
    category: "fraud_risk",
    evidence,
    transcriptReference: reference || "",
    expected,
    recommendedFix: fix,
    confidence: 0.72
  };
}

function findSnippet(text, pattern) {
  const source = String(text || "").replace(/\s+/g, " ").trim();
  const match = source.match(pattern);
  if (!match || match.index === undefined) return "";
  const start = Math.max(0, match.index - 90);
  return source.slice(start, start + 220).trim();
}

function asNumberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function writeLog(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    await fs.appendFile(logPath, line, "utf8");
  } catch {
    // Logging must never stop a review.
  }
}
