/**
 * server.js — FileConvert Pro Backend v3
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

const users = new Map();

function getUser(key) {
  if (!users.has(key)) users.set(key, { credits: 10, plan: "free" });
  return users.get(key);
}

const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin: "*",
  exposedHeaders: ["X-Output-Filename", "X-Output-Size", "X-Credits-Left", "Content-Disposition"],
}));

app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.MAX_FILE_MB * 1024 * 1024 },
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({ success: true, status: "running", version: "3.0.0", hasApiKey: !!CONFIG.CONVERTAPI_SECRET });
});

// ── Balance ───────────────────────────────────────────────────────────────────
app.get("/balance", (req, res) => {
  const user = getUser(req.headers["x-license-key"] || "free");
  res.json({ success: true, credits: user.credits, plan: user.plan });
});

// ── Convert ───────────────────────────────────────────────────────────────────
app.post("/convert/:from/to/:to", upload.single("File"), async (req, res) => {
  const { from, to } = req.params;
  const licenseKey   = req.headers["x-license-key"] || "free";

  if (!req.file) return res.status(400).json({ success: false, error: "No file uploaded." });

  const user = getUser(licenseKey);
  if (user.credits < 1) return res.status(402).json({ success: false, error: "Not enough credits." });
  if (!CONFIG.CONVERTAPI_SECRET) return res.status(500).json({ success: false, error: "API key not configured." });

  try {
    console.log(`[Convert] ${from} → ${to}, file: ${req.file.originalname}, size: ${req.file.size}`);

    // Шаг 1: Отправляем в ConvertAPI
    const apiResult = await callConvertAPI(req.file, from, to);
    console.log("[ConvertAPI Response] Code:", apiResult.Code, "Files:", apiResult.Files?.length);

    if (!apiResult.Files || !apiResult.Files[0]) {
      console.error("[ConvertAPI] No files in response:", JSON.stringify(apiResult));
      return res.status(500).json({ success: false, error: "ConvertAPI returned no files." });
    }

    const outputFile = apiResult.Files[0];
    console.log("[ConvertAPI] Output file:", outputFile.FileName, "HasUrl:", !!outputFile.Url, "HasData:", !!outputFile.FileData);

    // Шаг 2: Получаем файл
    let fileBuffer;

    if (outputFile.Url) {
      console.log("[Download] Downloading from URL:", outputFile.Url);
      fileBuffer = await downloadUrl(outputFile.Url);
      console.log("[Download] Success, size:", fileBuffer.length);
    } else if (outputFile.FileData) {
      console.log("[Base64] Decoding base64 data");
      fileBuffer = Buffer.from(outputFile.FileData, "base64");
      console.log("[Base64] Success, size:", fileBuffer.length);
    } else {
      return res.status(500).json({ success: false, error: "No file data in ConvertAPI response." });
    }

    // Шаг 3: Списываем кредит
    user.credits -= 1;
    console.log(`[Credits] ${licenseKey}: ${user.credits} left`);

    // Шаг 4: Отдаём файл
    const outputName = (outputFile.FileName) ||
      req.file.originalname.replace(/\.[^.]+$/, "") + "." + to;

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${outputName}"`);
    res.setHeader("Content-Length", fileBuffer.length);
    res.setHeader("X-Output-Filename", outputName);
    res.setHeader("X-Output-Size", fileBuffer.length);
    res.setHeader("X-Credits-Left", user.credits);
    return res.send(fileBuffer);

  } catch (err) {
    console.error("[Convert Error]", err.message, err.stack);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Webhook Prodamus ──────────────────────────────────────────────────────────
app.post("/webhook/prodamus", express.urlencoded({ extended: true }), (req, res) => {
  try {
    const { payment_status, customer_email, email, sum, order_sum } = req.body;
    const userEmail = customer_email || email || "";
    const amount    = parseFloat(sum || order_sum || 0);
    console.log("[Prodamus]", payment_status, userEmail, amount);
    if (payment_status === "paid") {
      const pack = detectPack(amount);
      if (pack && userEmail) {
        const user    = getUser(userEmail);
        user.credits += pack.credits;
        user.plan     = pack.plan;
        users.set(userEmail, user);
        console.log(`[Prodamus] +${pack.credits} for ${userEmail}, total: ${user.credits}`);
      }
    }
  } catch (e) {
    console.error("[Webhook Error]", e.message);
  }
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
        console.log("[ConvertAPI Raw] HTTP:", res.statusCode, "Body preview:", raw.substring(0, 300));
        try {
          const json = JSON.parse(raw);
          resolve(json);
        } catch (e) {
          reject(new Error("Invalid JSON from ConvertAPI: " + raw.substring(0, 200)));
        }
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

function detectPack(sum) {
  if (Math.abs(sum - 2.99)  < 0.5) return { plan: "micro",    credits: 25   };
  if (Math.abs(sum - 7.99)  < 0.5) return { plan: "standard", credits: 100  };
  if (Math.abs(sum - 17.99) < 0.5) return { plan: "pro",      credits: 300  };
  if (Math.abs(sum - 39.99) < 0.5) return { plan: "business", credits: 1000 };
  return null;
}

app.use((req, res) => res.status(404).json({ success: false, error: "Not found." }));

app.listen(CONFIG.PORT, () => {
  console.log(`✅ FileConvert Server v3 running on port ${CONFIG.PORT}`);
  console.log(`   API key configured: ${!!CONFIG.CONVERTAPI_SECRET}`);
});
