/**
 * server.js v5.1
 * + добавлен /payment/create для e-pay.plus
 */

const express  = require("express");
const cors     = require("cors");
const multer   = require("multer");
const https    = require("https");
const http     = require("http");
const FormData = require("form-data");
const convertEpubRouter = require("./routes/convertEpub");

const CONFIG = {
  PORT:              process.env.PORT || 3000,
  CONVERTAPI_SECRET: process.env.CONVERTAPI_SECRET || "",
  MAX_FILE_MB:       parseInt(process.env.MAX_FILE_MB) || 200,
  EPAY_API_KEY:      process.env.EPAY_API_KEY || "",
  EPAY_URL:          "https://livepay24.click/api/request/",
  SERVER_URL:        process.env.SERVER_URL || "https://fileconvert-api-4e9p.onrender.com",
  PACK_AMOUNT:       "1199",
  PACK_AMOUNT_USD:   "11.99",
  PACK_CREDITS:      100,
};

const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin: "*",
  exposedHeaders: ["X-Output-Filename", "X-Output-Size", "Content-Disposition"],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", convertEpubRouter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.MAX_FILE_MB * 1024 * 1024 },
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    success:    true,
    status:     "running",
    version:    "5.1.0",
    hasApiKey:  !!CONFIG.CONVERTAPI_SECRET,
    hasEpayKey: !!CONFIG.EPAY_API_KEY,
  });
});

// ── Create payment link ───────────────────────────────────────────────────────
app.post("/payment/create", (req, res) => {
  const licenseKey = req.body.licenseKey || "";

  if (!licenseKey) {
    return res.status(400).json({ success: false, error: "Email is required." });
  }

  if (!CONFIG.EPAY_API_KEY) {
    return res.status(500).json({ success: false, error: "Payment not configured on server." });
  }

  const orderId = encodeURIComponent(licenseKey) + "_" + Date.now();

  // Возвращаем поля формы — расширение создаст POST форму
  const formFields = [
    { name: "amount",            value: CONFIG.PACK_AMOUNT },
    { name: "merchant_order_id", value: orderId },
    { name: "use_card_payment",  value: "USD" },
    { name: "api_key",           value: CONFIG.EPAY_API_KEY },
    { name: "notice_url",        value: CONFIG.SERVER_URL + "/webhook/epay" },
    { name: "success_url",       value: CONFIG.SERVER_URL + "/payment/success" },
    { name: "fail_url",          value: CONFIG.SERVER_URL + "/payment/fail" },
  ];

  console.log("[Payment] Created for:", licenseKey, "| OrderId:", orderId);

  res.json({
    success:    true,
    formFields,
    amount:     CONFIG.PACK_AMOUNT_USD,
    credits:    CONFIG.PACK_CREDITS,
  });
});

// ── Success / Fail pages ──────────────────────────────────────────────────────
app.get("/payment/success", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Payment Successful</title>
  <style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
  .card{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px}
  .icon{font-size:48px;margin-bottom:16px}h1{color:#0f172a;font-size:24px;margin:0 0 8px}
  p{color:#64748b;margin:0 0 16px}.credits{background:#eff6ff;color:#2563eb;font-weight:700;padding:8px 20px;border-radius:8px;display:inline-block;margin-bottom:16px}
  small{color:#94a3b8;font-size:12px}</style></head>
  <body><div class="card"><div class="icon">🎉</div><h1>Payment Successful!</h1>
  <p>Your 100 conversions have been added.</p>
  <div class="credits">+100 conversions</div>
  <p><small>You can close this tab and return to the extension.</small></p></div></body></html>`);
});

app.get("/payment/fail", (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Payment Failed</title>
  <style>body{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
  .card{background:#fff;border-radius:16px;padding:40px;text-align:center;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px}
  .icon{font-size:48px;margin-bottom:16px}h1{color:#0f172a;font-size:24px;margin:0 0 8px}p{color:#64748b}</style></head>
  <body><div class="card"><div class="icon">😕</div><h1>Payment Failed</h1>
  <p>Something went wrong. Please try again.</p></div></body></html>`);
});

// ── Webhook from e-pay.plus ───────────────────────────────────────────────────
app.post("/webhook/epay", (req, res) => {
  try {
    const body    = req.body;
    console.log("[Webhook e-pay]", JSON.stringify(body));
    // Здесь можно добавить логику зачисления кредитов через БД
  } catch (err) {
    console.error("[Webhook Error]", err.message);
  }
  return res.status(200).send("OK");
});

// ── Convert ───────────────────────────────────────────────────────────────────
app.post("/convert/:from/to/:to", upload.single("File"), async (req, res) => {
  const { from, to } = req.params;

  if (!req.file) {
    return res.status(400).json({ success: false, error: "No file uploaded." });
  }

  if (!CONFIG.CONVERTAPI_SECRET) {
    return res.status(500).json({ success: false, error: "API key not configured." });
  }

  try {
    console.log(`[Convert] ${from} → ${to} | ${req.file.originalname} | ${req.file.size} bytes`);

    const apiResult = await callConvertAPI(req.file, from, to);

    if (!apiResult.Files || !apiResult.Files[0]) {
      return res.status(500).json({ success: false, error: "ConvertAPI returned no output file." });
    }

    const outputFile = apiResult.Files[0];
    let fileBuffer;

    if (outputFile.Url) {
      fileBuffer = await downloadUrl(outputFile.Url);
    } else if (outputFile.FileData) {
      fileBuffer = Buffer.from(outputFile.FileData, "base64");
    } else {
      return res.status(500).json({ success: false, error: "No file data in response." });
    }

    // Sanitize filename — remove UUID prefix, encode for headers
    const rawName = outputFile.FileName ||
      req.file.originalname.replace(/\.[^.]+$/, "") + "." + to;

    // Remove UUID prefix if present (format: uuid-originalname)
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i;
    const cleanName = rawName.replace(uuidPattern, "");

    // Safe ASCII filename for Content-Disposition header
    const safeName = encodeURIComponent(cleanName);

    console.log(`[Done] ${cleanName} | ${fileBuffer.length} bytes`);

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename*=UTF-8\'\'${safeName}`);
    res.setHeader("Content-Length", fileBuffer.length);
    res.setHeader("X-Output-Filename", cleanName);
    res.setHeader("X-Output-Size", fileBuffer.length);
    return res.send(fileBuffer);

  } catch (err) {
    console.error("[Convert Error]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
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
        catch (e) { reject(new Error("Invalid JSON from ConvertAPI")); }
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
  console.log(`✅ FileConvert Server v5.1 running on port ${CONFIG.PORT}`);
  console.log(`   ConvertAPI: ${!!CONFIG.CONVERTAPI_SECRET} | e-pay: ${!!CONFIG.EPAY_API_KEY}`);
});
