/**
 * server.js — FileConvert Pro Backend
 *
 * Что делает этот сервер:
 * 1. Принимает файл от расширения
 * 2. Проксирует его в ConvertAPI (ключ хранится здесь, не в расширении)
 * 3. Возвращает готовый файл расширению
 * 4. Принимает webhook от Prodamus после оплаты
 * 5. Отдаёт баланс кредитов расширению
 *
 * Чтобы сменить ключ ConvertAPI — просто измени CONVERTAPI_SECRET
 * в переменных окружения Railway. Расширение обновлять не нужно.
 */

const express    = require("express");
const cors       = require("cors");
const multer     = require("multer");
const fetch      = require("node-fetch");
const FormData   = require("form-data");
const rateLimit  = require("express-rate-limit");

// ─── Config из переменных окружения ──────────────────────────────────────────
const CONFIG = {
  PORT:               process.env.PORT || 3000,
  CONVERTAPI_SECRET:  process.env.CONVERTAPI_SECRET || "",
  CONVERTAPI_BASE:    "https://v2.convertapi.com/convert",
  PRODAMUS_SECRET:    process.env.PRODAMUS_SECRET || "",  // секрет для проверки webhook
  MAX_FILE_MB:        parseInt(process.env.MAX_FILE_MB) || 200,
};

// ─── Кредиты пользователей (в памяти — для старта достаточно) ────────────────
// В продакшне замени на базу данных (PostgreSQL на Railway)
const credits = new Map();  // licenseKey → { credits, plan, email }

function getUser(key) {
  if (!credits.has(key)) {
    credits.set(key, { credits: 10, plan: "free", email: "" });
  }
  return credits.get(key);
}

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", 1);

app.use(cors({
  origin: "*",  // Разрешаем запросы от Chrome Extension
  exposedHeaders: ["X-Output-Filename", "X-Output-Size", "X-Credits-Left"],
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── Multer (приём файлов) ────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),  // храним файл в памяти (не на диске)
  limits:  { fileSize: CONFIG.MAX_FILE_MB * 1024 * 1024 },
});

// ─── Rate limiting ────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 60 * 1000,  // 1 минута
  max: 20,              // макс 20 запросов с одного IP в минуту
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please wait a moment." },
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function sendError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// Сколько кредитов стоит конвертация (можно настроить по форматам)
function getCost(fromExt, toExt) {
  return 1; // пока всё стоит 1 кредит
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

// Проверка работы сервера
app.get("/health", (req, res) => {
  res.json({
    success: true,
    status:  "running",
    version: "1.0.0",
    hasApiKey: !!CONFIG.CONVERTAPI_SECRET,
  });
});

// ── Получить баланс кредитов ─────────────────────────────────────────────────
app.get("/balance", (req, res) => {
  const key  = req.headers["x-license-key"] || req.query.key || "free";
  const user = getUser(key);
  res.json({
    success: true,
    credits: user.credits,
    plan:    user.plan,
  });
});

// ── Конвертация файла ────────────────────────────────────────────────────────
app.post("/convert/:from/to/:to", limiter, upload.single("File"), async (req, res) => {
  const { from, to } = req.params;
  const licenseKey   = req.headers["x-license-key"] || "free";

  // Проверяем файл
  if (!req.file) {
    return sendError(res, 400, "No file uploaded.");
  }

  // Проверяем кредиты
  const user = getUser(licenseKey);
  const cost = getCost(from, to);

  if (user.credits < cost) {
    return sendError(res, 402, "Not enough credits. Please purchase a pack.");
  }

  // Проверяем API ключ
  if (!CONFIG.CONVERTAPI_SECRET) {
    return sendError(res, 500, "API key not configured on server.");
  }

  try {
    // Пересылаем файл в ConvertAPI
    const formData = new FormData();
    formData.append("File", req.file.buffer, {
      filename:    req.file.originalname,
      contentType: req.file.mimetype,
    });

    const apiUrl  = `${CONFIG.CONVERTAPI_BASE}/${from}/to/${to}?Secret=${CONFIG.CONVERTAPI_SECRET}`;
    const apiResp = await fetch(apiUrl, {
      method:  "POST",
      body:    formData,
      headers: formData.getHeaders(),
      timeout: 120000,  // 2 минуты таймаут
    });

    const data = await apiResp.json();

    if (!apiResp.ok || data.Code !== 200) {
      // Обрабатываем ошибки ConvertAPI
      if (apiResp.status === 401 || apiResp.status === 403) {
        return sendError(res, 500, "Invalid ConvertAPI key. Contact support.");
      }
      if (apiResp.status === 429) {
        return sendError(res, 429, "Conversion limit reached. Please try again later.");
      }
      return sendError(res, 500, data.Message || "Conversion failed.");
    }

    if (!data.Files?.[0]) {
      return sendError(res, 500, "No output file returned from conversion service.");
    }

    // Списываем кредит только после успешной конвертации
    user.credits -= cost;

    // Получаем выходной файл
    const outputFile = data.Files[0];
    const outputName = outputFile.FileName ||
      req.file.originalname.replace(/\.[^.]+$/, "") + "." + to;

    // Если ConvertAPI вернул URL — скачиваем файл и отдаём пользователю
    if (outputFile.Url) {
      const fileResp = await fetch(outputFile.Url);
      if (!fileResp.ok) {
        return sendError(res, 500, "Could not download converted file.");
      }

      const buffer = await fileResp.buffer();

      res.setHeader("Content-Type", fileResp.headers.get("content-type") || "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${outputName}"`);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("X-Output-Filename", outputName);
      res.setHeader("X-Output-Size", buffer.length);
      res.setHeader("X-Credits-Left", user.credits);
      return res.send(buffer);
    }

    // Если ConvertAPI вернул base64
    if (outputFile.FileData) {
      const buffer = Buffer.from(outputFile.FileData, "base64");

      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${outputName}"`);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("X-Output-Filename", outputName);
      res.setHeader("X-Output-Size", buffer.length);
      res.setHeader("X-Credits-Left", user.credits);
      return res.send(buffer);
    }

    return sendError(res, 500, "Unexpected response from conversion service.");

  } catch (err) {
    console.error("[Convert Error]", err.message);
    if (err.type === "request-timeout") {
      return sendError(res, 504, "Conversion timed out. Try a smaller file.");
    }
    return sendError(res, 500, "Server error. Please try again.");
  }
});

// ── Webhook от Prodamus (зачисление кредитов после оплаты) ───────────────────
app.post("/webhook/prodamus", async (req, res) => {
  try {
    const body = req.body;

    console.log("[Prodamus Webhook]", JSON.stringify(body));

    // Prodamus присылает: payment_status, order_id, customer_email, sum и др.
    const status = body.payment_status;
    const email  = body.customer_email || body.email || "";
    const sum    = parseFloat(body.sum || body.order_sum || 0);

    // Принимаем только успешные оплаты
    if (status !== "paid") {
      return res.status(200).send("OK");  // Всегда отвечаем 200 чтобы Prodamus не повторял
    }

    // Определяем пакет по сумме
    const pack = detectPack(sum);
    if (!pack) {
      console.warn("[Prodamus] Unknown sum:", sum);
      return res.status(200).send("OK");
    }

    // Зачисляем кредиты
    // Ключ лицензии = email пользователя (простой вариант для старта)
    const user = getUser(email);
    user.credits += pack.credits;
    user.plan     = pack.plan;
    user.email    = email;
    credits.set(email, user);

    console.log(`[Prodamus] +${pack.credits} credits for ${email}. Total: ${user.credits}`);

    // Prodamus ожидает HTTP 200 в ответ
    return res.status(200).send("OK");

  } catch (err) {
    console.error("[Webhook Error]", err.message);
    // Даже при ошибке отвечаем 200 — иначе Prodamus будет повторять webhook бесконечно
    return res.status(200).send("OK");
  }
});

// ─── Определение пакета по сумме оплаты ──────────────────────────────────────
function detectPack(sum) {
  // Допуск ±0.5 для учёта комиссий
  if (Math.abs(sum - 2.99)  < 0.5) return { plan: "micro",    credits: 25   };
  if (Math.abs(sum - 7.99)  < 0.5) return { plan: "standard", credits: 100  };
  if (Math.abs(sum - 17.99) < 0.5) return { plan: "pro",      credits: 300  };
  if (Math.abs(sum - 39.99) < 0.5) return { plan: "business", credits: 1000 };
  return null;
}

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ success: false, error: "Endpoint not found." });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`✅ FileConvert Server running on port ${CONFIG.PORT}`);
  console.log(`   API key configured: ${!!CONFIG.CONVERTAPI_SECRET}`);
  console.log(`   GET  /health`);
  console.log(`   GET  /balance`);
  console.log(`   POST /convert/:from/to/:to`);
  console.log(`   POST /webhook/prodamus`);
});
