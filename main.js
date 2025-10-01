/**
 * main.js
 * Reconstruye imagen de "árbol genealógico" rebrandteada como Consulta PE
 *
 * Endpoints:
 *  GET /agv-proc?dni=XXXXXXXX  -> procesa la imagen devuelta por /agv?dni=... y devuelve JSON con urls.FILE
 *
 * Requisitos:
 *  - Colocar `public/bg.png` (fondo/plantilla) y `public/logo.png` (logo Consulta PE) antes de ejecutar.
 *  - npm install
 *
 * Heurística:
 *  - Descarga la imagen original (desde la API agv)
 *  - OCR completo con tesseract.js para extraer texto
 *  - Divide la imagen original en GRID_COLS x GRID_ROWS celdas y selecciona celdas "con fotos"
 *  - Reconstruye nueva imagen: fondo propio + logo + thumbnails detectados + texto OCR organizado
 *
 * Resultado:
 *  - Imagen PNG redondeada almacenada en /public y JSON con urls.FILE
 */

const express = require("express");
const axios = require("axios");
const Jimp = require("jimp");
const Tesseract = require("tesseract.js");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";

const PUBLIC_DIR = path.join(__dirname, "public");
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// Config — ajusta si hace falta
const REMOTE_BASE = "https://web-production-75681.up.railway.app";
const API_AGV_PATH = "/agv"; // endpoint original que devuelve la imagen
const GRID_COLS = 7; // heurística: cuantas columnas tiene la rejilla en la imagen original
const GRID_ROWS = 5; // heurística: cuantas filas
const THUMB_MIN_VARIANCE = 800; // umbral para considerar una celda con "foto"
const OUTPUT_WIDTH = 1080; // tamaño de salida (px)
const OUTPUT_HEIGHT = 1920; // tamaño de salida (px)
const BG_PATH = path.join(PUBLIC_DIR, "bg.png"); // tu fondo Consulta PE (agregar)
const LOGO_PATH = path.join(PUBLIC_DIR, "logo.png"); // tu logo Consulta PE (agregar)

app.use("/public", express.static(PUBLIC_DIR));

/**
 * Descarga una URL binaria y devuelve Buffer
 */
async function downloadBuffer(url) {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 20000 });
  return Buffer.from(res.data);
}

/**
 * Heurística simple para detectar "celdas con foto" en la imagen original:
 * - Cortamos la imagen en GRID_COLS x GRID_ROWS
 * - Para cada celda calculamos la varianza del canal luminosidad (grayscale variance)
 * - Aquellas con varianza alta se consideran con contenido "foto"
 */
async function detectThumbnailsFromImage(jimpImage) {
  const w = jimpImage.bitmap.width;
  const h = jimpImage.bitmap.height;
  const cellW = Math.floor(w / GRID_COLS);
  const cellH = Math.floor(h / GRID_ROWS);

  const candidates = [];

  for (let ry = 0; ry < GRID_ROWS; ry++) {
    for (let cx = 0; cx < GRID_COLS; cx++) {
      const x = cx * cellW;
      const y = ry * cellH;
      const clone = jimpImage.clone().crop(x, y, cellW, cellH);

      // convertir a grayscale y medir varianza
      let sum = 0, sum2 = 0, n = 0;
      clone.scan(0, 0, clone.bitmap.width, clone.bitmap.height, function (xx, yy, idx) {
        const r = this.bitmap.data[idx + 0];
        const g = this.bitmap.data[idx + 1];
        const b = this.bitmap.data[idx + 2];
        const lum = Math.round(0.299*r + 0.587*g + 0.114*b);
        sum += lum; sum2 += lum*lum; n++;
      });
      const mean = sum / n;
      const variance = sum2 / n - mean * mean;

      // también calculamos cobertura de píxeles "de color piel" simple (heurística)
      let skinCount = 0;
      clone.scan(0, 0, clone.bitmap.width, clone.bitmap.height, function (xx, yy, idx) {
        const r = this.bitmap.data[idx + 0];
        const g = this.bitmap.data[idx + 1];
        const b = this.bitmap.data[idx + 2];
        // heurística simple para tonos piel (no perfecta)
        if (r > 90 && g > 40 && b > 20 && (r - g) > 15 && (r - b) > 15) skinCount++;
      });
      const skinRatio = skinCount / (clone.bitmap.width*clone.bitmap.height);

      if (variance >= THUMB_MIN_VARIANCE || skinRatio > 0.02) {
        candidates.push({
          x, y, w: cellW, h: cellH,
          variance, skinRatio
        });
      }
    }
  }

  // ordenar por varianza desc — los "más fotográficos" primero
  candidates.sort((a,b) => (b.variance + b.skinRatio*1000) - (a.variance + a.skinRatio*1000));
  return candidates;
}

/**
 * Ejecuta OCR con tesseract.js sobre un buffer o jimp image
 */
async function doOCRBuffer(buffer) {
  try {
    const worker = Tesseract.createWorker({ logger: m => {} });
    await worker.load();
    await worker.loadLanguage("eng+spa");
    await worker.initialize("eng+spa");
    const { data: { text } } = await worker.recognize(buffer);
    await worker.terminate();
    return text;
  } catch (e) {
    console.error("OCR error:", e);
    return "";
  }
}

/**
 * Construye la nueva imagen rebrandeada:
 * - Usa BG_PATH como fondo (si existe), sino color sólido
 * - Pega logo arriba
 * - Pega thumbnails detectados a la derecha/izquierda en rejilla
 * - Pega texto OCR a la izquierda en columnas
 */
async function buildRebrandedImage(originalBuffer, ocrText, thumbs, dni) {
  // Cargar background o crear uno
  let bg;
  if (fs.existsSync(BG_PATH)) {
    bg = await Jimp.read(BG_PATH);
    bg.resize(OUTPUT_WIDTH, OUTPUT_HEIGHT);
  } else {
    bg = new Jimp(OUTPUT_WIDTH, OUTPUT_HEIGHT, "#092230");
  }

  // preparar fuente
  const fontTitle = await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE);
  const fontH = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
  const fontData = await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE);

  // logo si existe
  if (fs.existsSync(LOGO_PATH)) {
    try {
      const logo = await Jimp.read(LOGO_PATH);
      logo.resize(220, Jimp.AUTO);
      bg.composite(logo, OUTPUT_WIDTH - logo.bitmap.width - 36, 30);
    } catch {}
  }

  // Título
  bg.print(fontTitle, 48, 40, `ÁRBOL GENEALÓGICO - ${dni}`);

  // dividir el espacio: izquierdo texto (50% ancho) y derecho thumbnails (45%)
  const textX = 48;
  const textWidth = Math.floor(OUTPUT_WIDTH * 0.52) - 96;
  const thumbsX = Math.floor(OUTPUT_WIDTH * 0.52) + 16;
  const thumbsWidth = OUTPUT_WIDTH - thumbsX - 48;

  // Pegar thumbnails en una rejilla vertical dentro de thumbsWidth
  const colCount = 3;
  const gap = 12;
  const thumbW = Math.floor((thumbsWidth - (colCount - 1) * gap) / colCount);
  let curY = 150;

  for (let i = 0; i < Math.min(thumbs.length, 30); i++) {
    const t = thumbs[i];
    try {
      const orig = await Jimp.read(originalBuffer);
      const crop = orig.clone().crop(t.x, t.y, t.w, t.h);
      crop.cover(thumbW, Math.floor((t.h/t.w)*thumbW));
      const col = i % colCount;
      const row = Math.floor(i / colCount);
      const x = thumbsX + col * (thumbW + gap);
      const y = 150 + row * (Math.floor(thumbW * 1.05) + gap);
      bg.composite(crop, x, y);

      // opcional: dibujar un pequeño marco blanco
      const border = new Jimp(crop.bitmap.width, crop.bitmap.height, 0x00000000);
      border.scan(0,0,border.bitmap.width,border.bitmap.height,(xx,yy,idx) => {
        if (xx<3||yy<3||xx>border.bitmap.width-4||yy>border.bitmap.height-4) {
          border.bitmap.data[idx+0]=255; border.bitmap.data[idx+1]=255; border.bitmap.data[idx+2]=255; border.bitmap.data[idx+3]=150;
        }
      });
      bg.composite(border, x, y);
    } catch (e) {
      // ignore
    }
  }

  // Render OCR text en dos columnas en el área izquierda
  const lines = ocrText.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  let leftY = 150;
  const colGap = 24;
  const cols = 2;
  const colW = Math.floor((textWidth - colGap) / cols);

  // organizar lines por longitud para distribuir
  let colIdx = 0;
  let xCol = textX;

  for (let i = 0; i < lines.length; i++) {
    xCol = textX + colIdx * (colW + colGap);
    leftY = printWrappedJimp(bg, fontData, xCol, leftY, colW, lines[i], 26);
    // saltar a siguiente columna si se pasa de altura
    if (leftY > OUTPUT_HEIGHT - 300) {
      // reset Y y mover a siguiente columna o finalizar
      leftY = 150;
      colIdx++;
      if (colIdx >= cols) break;
    }
  }

  // footer branding
  bg.print(fontH, textX, OUTPUT_HEIGHT - 140, "Consulta PE • Información reconstruida");
  bg.print(fontData, textX, OUTPUT_HEIGHT - 100, "Generado automáticamente. No es documento oficial.");

  // retornar buffer PNG
  return bg.getBufferAsync(Jimp.MIME_PNG);
}

/**
 * pequeño wrapper para imprimir texto envuelto usando Jimp.font
 */
function printWrappedJimp(image, font, x, y, maxWidth, text, lineHeight=26) {
  const words = text.split(/\s+/);
  let line = "";
  let curY = y;
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    const width = Jimp.measureText(font, test);
    if (width > maxWidth && line) {
      image.print(font, x, curY, line);
      curY += lineHeight;
      line = w;
    } else line = test;
  }
  if (line) {
    image.print(font, x, curY, line);
    curY += lineHeight;
  }
  return curY;
}

/**
 * Endpoint principal
 * GET /agv-proc?dni=XXXX
 */
app.get("/agv-proc", async (req, res) => {
  const dni = String(req.query.dni || "").trim();
  if (!dni || !/^\d{6,}$/i.test(dni)) {
    return res.status(400).json({ error: "Parámetro dni inválido. Ej: ?dni=10001088" });
  }

  try {
    // 1) Llamar a API /agv para obtener imagen o JSON que contenga urls.FILE
    const agvUrl = `${REMOTE_BASE}${API_AGV_PATH}?dni=${encodeURIComponent(dni)}`;
    const apiResp = await axios.get(agvUrl, { timeout: 20000 }).catch(err => {
      throw new Error(`Error llamando API agv: ${err.message}`);
    });

    // Si la API devuelve JSON con urls.FILE -> descargamos esa imagen
    let imageBuffer = null;
    if (apiResp.data && apiResp.data.urls && apiResp.data.urls.FILE) {
      const fileUrl = apiResp.data.urls.FILE;
      console.log("Descargando imagen desde:", fileUrl);
      imageBuffer = await downloadBuffer(fileUrl);
    } else {
      // Si la API devolvió una imagen binaria directamente (por ejemplo content-type: image/jpeg)
      const contentType = apiResp.headers && apiResp.headers["content-type"];
      if (contentType && contentType.startsWith("image")) {
        imageBuffer = Buffer.from(apiResp.data);
      } else {
        // intentar acceso directo a endpoint de imagen /files/...
        // como fallback, respondemos con error
        throw new Error("La API agv no devolvió urls.FILE ni imagen directa.");
      }
    }

    // 2) Correr OCR sobre la imagen completa (puede tardar)
    console.log("Ejecutando OCR (puede tardar)...");
    const ocrText = await doOCRBuffer(imageBuffer);

    // 3) Detectar thumbnails candidatos con heurística
    const jimpOrig = await Jimp.read(imageBuffer);
    const thumbs = await detectThumbnailsFromImage(jimpOrig);

    // 4) Construir nueva imagen rebrandeada
    console.log("Construyendo imagen rebrandeada...");
    const newImgBuffer = await buildRebrandedImage(imageBuffer, ocrText, thumbs, dni);

    // 5) Guardar imagen en /public y devolver URL y JSON similar al original
    const outName = `agv_rebrand_${dni}_${uuidv4()}.png`;
    const outPath = path.join(PUBLIC_DIR, outName);
    await fs.promises.writeFile(outPath, newImgBuffer);

    // devolvemos estructura similar a la original
    const resultJson = {
      bot: "@LEDERDATA_OFC_BOT",
      chat_id: Date.now(),
      date: new Date().toISOString(),
      fields: { dni },
      from_id: Date.now(),
      message: ocrText || `Imagen procesada para DNI ${dni}`,
      parts_received: 1,
      urls: {
        FILE: `${req.protocol}://${req.get("host")}/public/${outName}`
      }
    };

    return res.json(resultJson);

  } catch (error) {
    console.error("Error en /agv-proc:", error);
    return res.status(500).json({ error: "Error procesando imagen", detalle: String(error.message) });
  }
});

app.get("/status", (req,res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Ejemplo: http://localhost:${PORT}/agv-proc?dni=10001088`);
});
