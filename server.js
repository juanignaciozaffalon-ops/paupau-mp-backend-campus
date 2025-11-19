// server.js – Backend PauPau (Mercado Pago + cupones + comprobantes)

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mercadopago = require("mercadopago");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

/* ============================
   MERCADO PAGO
============================ */
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN,
});

/* ============================
   SUPABASE (acepta varios nombres de KEY)
============================ */
const supabaseUrl = process.env.SUPABASE_URL || null;
const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE || // tu variable principal en Render
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET ||
  process.env.SUPABASE_KEY ||
  null;

let supabase = null;

if (!supabaseUrl || !supabaseKey) {
  console.warn(
    "⚠️ Supabase NO configurado (falta SUPABASE_URL o KEY). " +
      "Cupones y comprobantes estarán desactivados."
  );
} else {
  console.log("✅ Supabase configurado con URL:", supabaseUrl);
  supabase = createClient(supabaseUrl, supabaseKey);
}

const monthStr = () => new Date().toISOString().slice(0, 7);

/* ============================
   EXPRESS + CORS
============================ */

// dominios base permitidos
const baseAllowedOrigins = [
  "https://paupaulanguages.com",
  "https://www.paupaulanguages.com",
  "https://paupaulanguages.odoo.com",
  "https://famous-lily-8e39ce.netlify.app", // campus
  "http://localhost:3000",
  "http://localhost:5173",
];

// si tenés la variable ALLOWED_ORIGIN en Render, la sumamos
let extraAllowed = [];
if (process.env.ALLOWED_ORIGIN) {
  extraAllowed = process
    .env.ALLOWED_ORIGIN.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const allowedOrigins = [...new Set([...baseAllowedOrigins, ...extraAllowed])];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      console.log("CORS bloqueado para:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// Multer para comprobantes
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

/* ============================
   ROOT
============================ */
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "Backend PauPau funcionando" });
});

/* ============================
   CUPONES – /coupon/apply
============================ */
app.post("/coupon/apply", async (req, res) => {
  try {
    const { user_id, month, code } = req.body || {};

    if (!user_id || !code) {
      return res.json({
        ok: false,
        msg: "Faltan datos para aplicar cupón.",
      });
    }

    if (!supabase) {
      return res.json({
        ok: false,
        msg: "El sistema de cupones no está disponible en este momento.",
      });
    }

    const normalizedCode = String(code).toLowerCase();

    // NO filtramos por "active" para evitar errores si la columna no existe
    const { data: coupons, error: couponErr } = await supabase
      .from("coupons")
      .select("*")
      .eq("code", normalizedCode)
      .limit(1);

    if (couponErr) {
      console.error("Error leyendo cupón:", couponErr);
      return res.json({
        ok: false,
        msg: "Error al validar el cupón.",
      });
    }

    if (!coupons || coupons.length === 0) {
      return res.json({
        ok: false,
        msg: "Cupón inválido o inactivo.",
      });
    }

    const coupon = coupons[0];

    // Tomamos el porcentaje de descuento de la columna que ya tenés
    const discountPercent = Number(
      coupon.discount_percent ?? coupon.percentage ?? 0
    );

    // Si tenés una columna "active" y está en false, lo tratamos como inactivo.
    if (coupon.active === false) {
      return res.json({
        ok: false,
        msg: "Cupón inválido o inactivo.",
      });
    }

    // Registrar uso (opcional, si existe la tabla coupon_uses)
    try {
      await supabase.from("coupon_uses").insert({
        coupon_id: coupon.id,
        user_id,
        month_year: month || monthStr(),
        discount_percent: discountPercent,
      });
    } catch (e) {
      console.warn("No se pudo registrar uso de cupón (tabla opcional).");
    }

    return res.json({
      ok: true,
      msg: "Cupón aplicado correctamente.",
      discount_percent: discountPercent,
    });
  } catch (err) {
    console.error("Error en /coupon/apply:", err);
    return res.json({
      ok: false,
      msg: "Error interno al aplicar el cupón.",
    });
  }
});

/* ============================
   CREAR PREFERENCIA – /crear-preferencia
============================ */
app.post("/crear-preferencia", async (req, res) => {
  try {
    const { title, price, currency, back_urls, metadata = {} } = req.body || {};

    if (!title || !price) {
      return res.status(400).json({
        error: "bad_request",
        message: "title y price son requeridos",
      });
    }

    const preference = {
      items: [
        {
          title: String(title),
          quantity: 1,
          unit_price: Number(price),
          currency_id: currency || "ARS",
        },
      ],
      back_urls:
        back_urls || {
          success: process.env.FRONTEND_URL || "https://paupaulanguages.com",
          failure: process.env.FRONTEND_URL || "https://paupaulanguages.com",
          pending: process.env.FRONTEND_URL || "https://paupaulanguages.com",
        },
      auto_return: "approved",
      metadata: { ...metadata },
    };

    const mpResp = await mercadopago.preferences.create(preference);

    return res.json({
      ok: true,
      id: mpResp.body.id,
      init_point: mpResp.body.init_point,
      sandbox_init_point: mpResp.body.sandbox_init_point,
    });
  } catch (err) {
    console.error("Error en /crear-preferencia:", err);
    return res.status(500).json({
      error: "server_error",
      message: "Error al crear la preferencia",
    });
  }
});

/* ============================
   WEBHOOK MP – /webhook/mp
============================ */
app.post("/webhook/mp", async (req, res) => {
  try {
    const body = req.body || {};
    console.log("Webhook MP:", JSON.stringify(body));

    if (!supabase) {
      console.warn("Webhook recibido sin Supabase configurado.");
      return res.status(200).send("ok");
    }

    const topic = body.type || body.topic;
    const paymentId = body.data && body.data.id ? body.data.id : null;

    if (!paymentId) return res.status(200).send("ok");

    if (topic === "payment") {
      const payment = await mercadopago.payment.findById(paymentId);
      const p = payment.body || {};

      const status = p.status || "pending";
      const metadata = p.metadata || {};
      const userId = metadata.user_id;
      const month = metadata.month || monthStr();
      const amount = Number(p.transaction_amount || 0);

      if (userId) {
        await supabase.from("payments").insert({
          user_id: userId,
          month_year: month,
          status,
          amount,
          mp_payment_id: p.id,
          mp_status_detail: p.status_detail || null,
        });
      }
    }

    return res.status(200).send("ok");
  } catch (err) {
    console.error("Error en webhook MP:", err);
    return res.status(200).send("ok");
  }
});

/* ============================
   SUBIR COMPROBANTE – /payments/upload-receipt
============================ */
app.post(
  "/payments/upload-receipt",
  upload.single("file"),
  async (req, res) => {
    try {
      const { user_id, month } = req.body || {};
      const file = req.file;

      if (!user_id || !file) {
        return res.status(400).json({
          ok: false,
          msg: "user_id y archivo son requeridos.",
        });
      }

      if (!supabase) {
        return res.json({
          ok: false,
          msg: "El sistema de comprobantes no está disponible.",
        });
      }

      const bucket = "payment_receipts";
      const ext = file.originalname.includes(".")
        ? file.originalname.split(".").pop()
        : "bin";
      const path = `user_${user_id}/${(month || monthStr())}_${Date.now()}.${ext}`;

      const { error: uploadErr } = await supabase.storage
        .from(bucket)
        .upload(path, file.buffer, {
          upsert: false,
          contentType: file.mimetype || "application/octet-stream",
        });

      if (uploadErr) {
        console.error("Error subiendo a Storage:", uploadErr);
        return res.status(500).json({
          ok: false,
          msg: "No se pudo guardar el comprobante.",
        });
      }

      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
      const publicUrl = pub?.publicUrl || null;

      try {
        await supabase.from("payment_receipts").insert({
          user_id,
          month_year: month || monthStr(),
          file_path: path,
          public_url: publicUrl,
        });
      } catch (e) {
        console.warn(
          "No se pudo insertar en payment_receipts (tabla opcional)."
        );
      }

      return res.json({
        ok: true,
        msg: "Comprobante subido correctamente.",
        url: publicUrl,
      });
    } catch (err) {
      console.error("Error en /payments/upload-receipt:", err);
      return res.status(500).json({
        ok: false,
        msg: "Error al subir el comprobante.",
      });
    }
  }
);

/* ============================
   START
============================ */
app.listen(PORT, () => {
  console.log(`🚀 Backend PauPau escuchando en puerto ${PORT}`);
});
