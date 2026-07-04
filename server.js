/**
 * server.js — FileConvert Pro Backend v2
 * Упрощённая версия — решает проблему с возвратом файла от ConvertAPI
 */

const express   = require("express");
const cors      = require("cors");
const multer    = require("multer");
const https     = require("https");
const http      = require("http");
const FormData  = require("form-data");

const CONFIG = {
  PORT:              process.env.PORT || 3000,
  CONVERTAPI_SECRET: process.env.CONVERTAPI_SECRET || "",
  CONVERTAPI_BASE:   "v2.convertapi.com",
  MAX_FILE_MB:       parseInt(process.env.MAX_FILE_MB) || 200,
};

// Кредиты пользователей (в памяти)
const users = new Map();

function getUser(key) {
  if (!users.has(key)) {
    users.set(key, { credits: 10, plan: "free" });
  }
  return users.get(key);
}

const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin: "*",
  exposedHeaders: ["X-Output-Filename", "X-Output-Size", "X-Credits-Left", "Content-Disposition"],
}));

app.use(express.json());

// Multer — храним файл в памяти
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: CONFIG.MAX_FILE_MB * 1024 * 1024 },
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    success:   true,
    status:    "running",
    version:   "2.0.0",
    hasApiKey: !!CONFIG.CONVERTAPI_SECRET,
  });
});

// ── Balance ───────────────────────────────────────────────────────────────────
app.get("/balance", (req, res) => {
  const key  = req.headers["x-license-key"] || "free";
  const user = getUser(key);
  res.json({ success: true, credits: user.credits, plan: user.plan });
});

// ── Convert ───────────────────────────────────────────────────────────────────
app.post("/convert/:from/to/:to", upload.single("File"), async (req, res) => {
  const { from, to } = req.params;
  const licenseKey   = req.headers["x-license-key"] || "free";

  if (!req.file) {
    return res.status(400).json({ success: false, error: "No file uploaded." });
  }

  const user = getUser(licenseKey);
  if (user.credits < 1) {
    return res.status(402).json({ success: false, error: "Not enough credits. Please purchase a pack." });
  }

  if (!CONFIG.CONVERTAPI_SECRET) {
    return res.status(500).json({ success: false, error: "API key not configured." });
  }

  try {
    // Шаг 1: Отправляем файл в ConvertAPI через multipart form
    const result = await sendToConvertAPI(req.file, from, to);

    if (!result.success) {
      return res.status(500).json({ success: false, error: result.error });
    }

    // Шаг 2: Скачиваем готовый файл
    const fileBuffer = await downloadFile(result.url);

    // Шаг 3: Списываем кредит
    user.credits -= 1;

    // Шаг 4: Отправляем файл пользователю
    const outputName = req.file.originalname.replace(/\.[^.]+$/, "") + "." + to;

    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", `attachment; filename="${outputName}"`);
    res.setHeader("Content-Length", fileBuffer.length);
    res.setHeader("X-Output-Filename", outputName);
    res.setHeader("X-Output-Size", fileBuffer.length);
    res.setHeader("X-Credits-Left", user.credits);
    return res.send(fileBuffer);

  } catch (err) {
    console.error("[Convert Error]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ── Prodamus Webhook ──────────────────────────────────────────────────────────
app.post("/webhook/prodamus", express.urlencoded({ extended: true }), (req, res) => {
  try {
    const body   = req.body;
    const status = body.payment_status;
    const email  = body.customer_email || body.email || "";
    const sum    = parseFloat(body.sum || body.order_sum || 0);

    console.log("[Prodamus]", { status, email, sum });

    if (status === "paid") {
      const pack = detectPack(sum);
      if (pack && email) {
        const user    = getUser(email);
        user.credits += pack.credits;
        user.plan     = pack.plan;
        users.set(email, user);
        console.log(`[Prodamus] +${pack.credits} credits for ${email}`);
      }
    }
    return res.status(200).send("OK");
  } catch (err) {
    console.error("[Webhook Error]", err.message);
    return res.status(200).send("OK");
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

// Отправка файла в ConvertAPI, возвращает URL готового файла
function sendToConvertAPI(file, from, to) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append("File", file.buffer, {
      filename:    file.originalname,
      contentType: file.mimetype,
    });

    const path    = `/convert/${from}/to/${to}?Secret=${CONFIG.CONVERTAPI_SECRET}`;
    const headers = form.getHeaders();
    const options = {
      hostname: CONFIG.CONVERTAPI_BASE,
      path,
      method:   "POST",
      headers:  { ...headers, "Content-Length": form.getLengthSync() },
      timeout:  120000,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);

          if (res.statusCode !== 200 || json.Code !== 200) {
            if (res.statusCode === 401 || res.statusCode === 403) {
              return resolve({ success: false, error: "Invalid ConvertAPI key." });
            }
            if (res.statusCode === 429) {
              return resolve({ success: false, error: "ConvertAPI limit reached." });
            }
            return resolve({ success: false, error: json.Message || `ConvertAPI error (${res.statusCode})` });
          }

          if (!json.Files || !json.Files[0]) {
            return resolve({ success: false, error: "No output file from ConvertAPI." });
          }

          // Возвращаем URL или base64
          if (json.Files[0].Url) {
            return resolve({ success: true, url: json.Files[0].Url, type: "url" });
          }
          if (json.Files[0].FileData) {
            return resolve({ success: true, data: json.Files[0].FileData, type: "base64" });
          }

          return resolve({ success: false, error: "Unexpected ConvertAPI response." });

        } catch (e) {
          return resolve({ success: false, error: "Failed to parse ConvertAPI response." });
        }
      });
    });

    req.on("error",   (e) => resolve({ success: false, error: e.message }));
    req.on("timeout", ()  => { req.destroy(); resolve({ success: false, error: "ConvertAPI timeout." }); });

    form.pipe(req);
  });
}

// Скачивание готового файла по URL
function downloadFile(url) {
  return new Promise((resolve, reject) => {
    // Определяем http или https
    const lib     = url.startsWith("https") ? https : http;
    const chunks  = [];

    lib.get(url, (res) => {
      // Обрабатываем редиректы
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadFile(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`Download failed: HTTP ${res.statusCode}`));
      }
      res.on("data",  chunk => chunks.push(chunk));
      res.on("end",   ()    => resolve(Buffer.concat(chunks)));
      res.on("error", err   => reject(err));
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
  console.log(`✅ FileConvert Server v2 running on port ${CONFIG.PORT}`);
  console.log(`   API key configured: ${!!CONFIG.CONVERTAPI_SECRET}`);
});
