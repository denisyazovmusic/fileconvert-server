// routes/convertEpub.js
//
// Подключается к УЖЕ СУЩЕСТВУЮЩЕМУ Express-приложению (тому же, что обслуживает PDF to DOC).
// Ничего нового не деплоим — просто добавляем роут в текущий сервис на Render.
//
// В твоём существующем server.js (или app.js) добавь:
//
//   const convertEpubRouter = require("./routes/convertEpub");
//   app.use("/api", convertEpubRouter);
//
// Если у тебя convertapi уже инициализирован в основном файле — можно передать
// готовый инстанс сюда вместо повторной инициализации (см. комментарий ниже).

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const os = require("os");

// Если convertapi уже создан в основном server.js, замени эту строку на:
//   module.exports = (convertapi) => { ... }  и передавай инстанс при подключении роута
const convertapi = require("convertapi")(process.env.CONVERTAPI_SECRET);

const router = express.Router();

const TMP_DIR = path.join(os.tmpdir(), "pdf-to-epub-uploads");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

const ALLOWED_EXT = [".pdf", ".docx", ".doc", ".txt", ".html", ".htm"];
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      return cb(new Error(`Формат ${ext} не поддерживается`));
    }
    cb(null, true);
  }
});

// POST /api/convert-epub
router.post("/convert-epub", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: "Файл не найден в запросе" });

    const uploadedPath = req.file.path;

    try {
      const result = await convertapi.convert("epub", { File: uploadedPath });
      const convertedFile = result.files[0];
      const outFileName =
        path.basename(req.file.originalname, path.extname(req.file.originalname)) + ".epub";

      res.setHeader("Content-Type", "application/epub+zip");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(outFileName)}"`
      );

      const fileBuffer = await convertedFile.buffer();
      res.send(Buffer.from(fileBuffer));
    } catch (convErr) {
      console.error("ConvertAPI error (epub):", convErr);
      res.status(502).json({ error: "Не удалось выполнить конвертацию. Попробуйте другой файл." });
    } finally {
      fs.unlink(uploadedPath, () => {});
    }
  });
});

module.exports = router;
