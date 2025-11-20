// server.js - Backend central PauPau (Render)
// Maneja: Mercado Pago, cupones, comprobantes y Supabase

const express = require("express");
const cors = require("cors");
const mercadopago = require("mercadopago");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();

// === CONFIGURACIÓN DESDE ENV ===
// En Render tenés que definir estas variables:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY
// MERCADOPAGO_ACCESS_TOKEN
// FRONTEND_URL  -> ej: https://paupaulanguages.com
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  MERCADOPAGO_ACCESS_TOKEN,
  FRONTEND_URL,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en ENV");
}
if (!MERCADOPAGO_ACCESS_TOKEN) {
  console.error("Falta MERCADOPAGO_ACCESS_TOKEN en ENV");
}
if (!FRONTEND_URL) {
  console.warn("No definiste FRONTEND_URL en ENV. Uso window.location.origin en el front.");
}

// === CORS ===
// Ajustá los orígenes permitidos según tus dominios reales
const allowedOrigins = [
  "https://paupaulanguages.com",
  "https://www.paupaulanguages.com",
  "https://paupaulanguages.odoo.com",
  "http://localhost:8069",
  "http://localhost:3000",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // Permitir herramientas tipo Postman (sin origin)
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Podés loguear si querés ver qué está pegando
      console.warn("CORS bloqueado para origen:", origin);
      return callback(null, false);
    },
  })
);

app.use(express.json());

// === MULTER para archivos (comprobantes) ===
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
});

// === SUPABASE SERVICE CLIENT (full power) ===
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// === MERCADO PAGO ===
mercadopago.configure({
  access_token: MERCADOPAGO_ACCESS_TOKEN,
});

// Simple health check
app.get("/", (req, res) => {
  res.send("PauPau backend OK");
});

/* ============================================================
   1) ENDPOINT CREAR PREFERENCIA MERCADO PAGO
   - Usado por el campus para pagar la cuota mensual
   - Recibe: { title, price, currency, back_urls, metadata }
   - Devuelve: { init_point }
============================================================ */
app.post("/crear-preferencia", async (req, res) => {
  try {
    const { title, price, currency, back_urls, metadata } = req.body || {};

    if (!price || !currency) {
      return res.status(400).json({
        ok: false,
        msg: "Faltan datos para crear la preferencia (price / currency).",
      });
    }

    const preference = {
      items: [
        {
          title: title || "Pago PauPau",
          quantity: 1,
          currency_id: currency,
          unit_price: Number(price),
        },
      ],
      back_urls: back_urls || {
        success: FRONTEND_URL || "https://paupaulanguages.com",
        failure: FRONTEND_URL || "https://paupaulanguages.com",
        pending: FRONTEND_URL || "https://paupaulanguages.com",
      },
      auto_return: "approved",
      metadata: metadata || {},
    };

    const mpResp = await mercadopago.preferences.create(preference);

    if (!mpResp || !mpResp.body || !mpResp.body.init_point) {
      console.error("Respuesta inesperada de Mercado Pago:", mpResp);
      return res.status(500).json({
        ok: false,
        msg: "No se pudo generar la preferencia de Mercado Pago.",
      });
    }

    return res.json({
      ok: true,
      init_point: mpResp.body.init_point,
    });
  } catch (err) {
    console.error("Error en /crear-preferencia:", err);
    return res.status(500).json({
      ok: false,
      msg: "Error interno creando preferencia de pago.",
    });
  }
});

/* ============================================================
   2) ENDPOINT CUPONES: /coupon/apply
   - Recibe: { user_id, month, code }
   - Busca en tabla coupons (Supabase)
   - Devuelve:
     - ok: true, discount_percent
     - ok: false, msg
============================================================ */
app.post("/coupon/apply", async (req, res) => {
  try {
    const { user_id, month, code } = req.body || {};
    if (!user_id || !code) {
      return res.status(400).json({
        ok: false,
        msg: "Faltan user_id o code.",
      });
    }

    const couponCode = String(code).trim().toLowerCase();

    const { data, error } = await supabase
      .from("coupons")
      .select("id, code, discount_percent, active, valid_from, valid_to, max_uses, used_count")
      .eq("code", couponCode)
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("Error consultando cupón:", error);
      return res.status(500).json({
        ok: false,
        msg: "Error interno al validar el cupón.",
      });
    }

    if (!data) {
      return res.json({
        ok: false,
        msg: "Cupón no encontrado.",
      });
    }

    if (!data.active) {
      return res.json({
        ok: false,
        msg: "El cupón no está activo.",
      });
    }

    const today = new Date();

    if (data.valid_from && new Date(data.valid_from) > today) {
      return res.json({
        ok: false,
        msg: "Este cupón todavía no está vigente.",
      });
    }

    if (data.valid_to && new Date(data.valid_to) < today) {
      return res.json({
        ok: false,
        msg: "Este cupón ya venció.",
      });
    }

    if (data.max_uses && data.used_count >= data.max_uses) {
      return res.json({
        ok: false,
        msg: "Este cupón ya alcanzó el máximo de usos.",
      });
    }

    // (Opcional) Podrías chequear si el alumno ya usó el cupón antes,
    // con una tabla coupon_redemptions. Para simplificar, no lo hago acá.

    return res.json({
      ok: true,
      discount_percent: data.discount_percent || 0,
    });
  } catch (err) {
    console.error("Error en /coupon/apply:", err);
    return res.status(500).json({
      ok: false,
      msg: "Error interno al validar el cupón.",
    });
  }
});

/* ============================================================
   3) ENDPOINT SUBIR COMPROBANTE: /payments/upload-receipt
   - Recibe multipart/form-data:
       file     => archivo
       user_id  => uuid del alumno
       month    => "YYYY-MM"
   - Sube archivo a Storage (bucket: payments_receipts)
   - Guarda registro en tabla payment_receipts
   - NO cambia el estado de payments (eso lo hace el front
     cuando inserta status = 'approved_full')
============================================================ */
app.post(
  "/payments/upload-receipt",
  upload.single("file"),
  async (req, res) => {
    try {
      const file = req.file;
      const { user_id, month } = req.body || {};

      if (!file) {
        return res.status(400).json({
          ok: false,
          msg: "No se recibió archivo.",
        });
      }

      if (!user_id || !month) {
        return res.status(400).json({
          ok: false,
          msg: "Faltan user_id o month.",
        });
      }

      const bucket = "payments_receipts";
      const safeName = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const path = `${user_id}/${month}/${Date.now()}_${safeName}`;

      // Subir a Supabase Storage
      const { error: uploadErr } = await supabase.storage
        .from(bucket)
        .upload(path, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadErr) {
        console.error("Error subiendo comprobante a Storage:", uploadErr);
        return res.status(500).json({
          ok: false,
          msg: "Error al guardar el comprobante.",
        });
      }

      const { data: pub } = supabase.storage.from(bucket).getPublicUrl(path);
      const publicUrl = pub?.publicUrl || null;

      // Registrar en tabla payment_receipts
      const { error: insertErr } = await supabase
        .from("payment_receipts")
        .insert({
          user_id,
          month_year: month,
          file_url: publicUrl,
        });

      if (insertErr) {
        console.error("Error insertando en payment_receipts:", insertErr);
        // No corto la respuesta, porque el archivo ya está subido.
      }

      return res.json({
        ok: true,
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

// === PUERTO ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("PauPau backend escuchando en puerto", PORT);
});
