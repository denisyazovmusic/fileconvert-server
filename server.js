/**
 * server.js v5
 * Кредиты считаются локально в расширении.
 * Сервер конвертирует файлы без проверки кредитов — 
 * доверяем расширению которое само ограничивает лимит.
 */

const express  = require("express");
const cors     = require("cors");
const multer   = require("multer");
const https    = require("https");
const http     = require("http");
const FormData = require("form-data");

const CONFIG = {
  PORT:              process.env.PORT || 3000,
  CONVERTAPI_SECRET: process.env.CONVERTAPI_SECRET || "",
  MAX_FILE_MB:       parseInt(process.env.MAX_FILE_MB) || 200,
};

const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin: "*",
  exposedHeaders: ["X-Output-Filename", "X-Output-Size", "Content-Disposition"],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.MAX_FILE_MB * 1024 * 1024 },
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    success:   true,
    status:    "running",
    version:   "5.0.0",
    hasApiKey: !!CONFIG.CONVERTAPI_SECRET,
  });
});

// ── Convert ───────────────────────────────────────────────────────────────────
// Сервер просто конвертирует — без проверки кредитов.
// Лимиты контролирует расширение локально через chrome.storage.
app.post("/convert/:from/to/:to", upload.single("File"), async (req, res) => {
  const { from, to } = req.params;

  if (!req.file) {
    return res.status(400).json({ success: false, error: "No file uploaded." });
  }

  if (!CONFIG.CONVERTAPI_SECRET) {
    return res.status(500).json({ success: false, error: "API key not configured on server." });
  }

  try {
    console.log(`[Convert] ${from} → ${to} | ${req.file.originalname} | ${req.file.size} bytes`);

    const apiResult = await callConvertAPI(req.file, from, to);

    if (!apiResult.Files || !apiResult.Files[0]) {
      console.error("[ConvertAPI] No files in response:", JSON.stringify(apiResult).slice(0, 200));
      return res.status(500).json({ success: false, error: "ConvertAPI returned no output file." });
    }

    const outputFile = apiResult.Files[0];
    let fileBuffer;

    if (outputFile.Url) {
      console.log("[Download] From URL:", outputFile.Url);
      fileBuffer = await downloadUrl(outputFile.Url);
    } else if (outputFile.FileData) {
      console.log("[Base64] Decoding...");
      fileBuffer = Buffer.from(outputFile.FileData, "base64");
    } else {
      return res.status(500).json({ success: false, error: "No file data in ConvertAPI response." });
    }

    const outputName = outputFile.FileName ||
      req.file.originalname.replace(/\.[^.]+$/, "") + "." + to;

    console.log(`[Done] ${outputName} | ${fileBuffer.length} bytes`);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${outputName}"`);
    res.setHeader("Content-Length", fileBuffer.length);
    res.setHeader("X-Output-Filename", outputName);
    res.setHeader("X-Output-Size", fileBuffer.length);
    return res.send(fileBuffer);

  } catch (err) {
    console.error("[Convert Error]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Webhook placeholder (для будущей оплаты) ─────────────────────────────────
app.post("/webhook/epay", (req, res) => {
  console.log("[Webhook]", JSON.stringify(req.body));
  return res.status(200).send("OK");
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function callConvertAPI(file, from, to) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("File", file.buffer, {
      filename:    file.originalname,
      contentType: file.mimetype,
    });

    const options = {
      hostname: "v2.convertapi.com",
      path:     `/convert/${from}/to/${to}?Secret=${CONFIG.CONVERTAPI_SECRET}`,
      method:   "POST",
      headers:  { ...form.getHeaders(), "Content-Length": form.getLengthSync() },
      timeout:  120000,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString();
        console.log("[ConvertAPI] HTTP:", res.statusCode, "| Preview:", raw.slice(0, 150));
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error("Invalid JSON from ConvertAPI: " + raw.slice(0, 100))); }
      });
    });

    req.on("error",   err => reject(err));
    req.on("timeout", ()  => { req.destroy(); reject(new Error("ConvertAPI timeout")); });
    form.pipe(req);
  });
}

function downloadUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    lib.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data",  c   => chunks.push(c));
      res.on("end",   ()  => resolve(Buffer.concat(chunks)));
      res.on("error", err => reject(err));
    }).on("error", err => reject(err));
  });
}

app.use((req, res) => res.status(404).json({ success: false, error: "Not found." }));

app.listen(CONFIG.PORT, () => {
  console.log(`✅ FileConvert Server v5 running on port ${CONFIG.PORT}`);
  console.log(`   ConvertAPI key: ${!!CONFIG.CONVERTAPI_SECRET}`);
  console.log(`   POST /convert/:from/to/:to`);
  console.log(`   GET  /health`);
});
