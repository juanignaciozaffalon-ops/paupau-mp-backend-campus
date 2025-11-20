/* ============================================
   SERVER.JS FINAL — PAUPAU CAMPUS BACKEND
   Cupón + MP + comprobantes OK
   ============================================ */

import express from "express";
import multer from "multer";
import cors from "cors";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import mercadopago from "mercadopago";

dotenv.config();
const app = express();
app.use(express.json());

// ============================
// CORS
// ============================
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // Postman / mismo servidor
      try {
        const allowed = (process.env.ALLOWED_ORIGIN || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (allowed.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error("CORS error: origin not allowed"));
      } catch (e) {
        console.error("CORS parse error:", e);
        return callback(new Error("CORS error"));
      }
    },
  })
);

// ============================
// ENV VALIDATION
// ============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const FRONTEND_URL =
  process.env.FRONTEND_URL || "https://famous-lily-8e39ce.netlify.app";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("❌ ERROR: SUPABASE_URL o SUPABASE_SERVICE_ROLE faltan en ENV");
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  console.error("❌ ERROR: MP_ACCESS_TOKEN faltando en ENV");
  process.exit(1);
}

// ============================
// SUPABASE CLIENT (service role)
// ============================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ============================
// MERCADO PAGO CONFIG
// ============================
mercadopago.configure({
  access_token: MP_ACCESS_TOKEN,
});

// ============================
// HEALTHCHECK
// ============================
app.get("/health", (req, res) => {
  res.json({ ok: true, message: "PauPau backend OK" });
});

// ============================
// CUPÓN — VERIFICAR
// (más tolerante: ignora tipo de 'active')
// ============================
app.post("/coupon/apply", async (req, res) => {
  try {
    const { code } = req.body || {};

    if (!code) {
      return res.json({ ok: false, msg: "Falta código de cupón" });
    }

    const normalizedCode = String(code).trim().toLowerCase();

    const { data, error } = await supabase
      .from("coupons")
      .select("code, discount_percent, active")
      .eq("code", normalizedCode);

    if (error) {
      console.error("Error consultando coupons:", error);
      return res.json({
        ok: false,
        msg: "Error al validar el cupón",
      });
    }

    if (!data || data.length === 0) {
      return res.json({
        ok: false,
        msg: "Cupón inválido o inactivo",
      });
    }

    const coupon = data[0];

    // Si existe columna active y está explícitamente en false -> inválido
    if (coupon.active === false) {
      return res.json({
        ok: false,
        msg: "Cupón inválido o inactivo",
      });
    }

    const discountPercent = Number(coupon.discount_percent || 0);

    return res.json({
      ok: true,
      discount_percent: discountPercent,
    });
  } catch (e) {
    console.error("Error general /coupon/apply:", e);
    return res.json({
      ok: false,
      msg: "Error interno al validar el cupón",
    });
  }
});

// ============================
// MERCADO PAGO – CREAR PREFERENCIA
// ============================
app.post("/crear-preferencia", async (req, res) => {
  try {
    const { title, price, currency, back_urls, metadata } = req.body || {};

    if (!price || !title) {
      return res
        .status(400)
        .json({ ok: false, msg: "Falta título o precio para la preferencia" });
    }

    // Si el frontend NO manda back_urls, usamos siempre el campus como retorno.
    const finalBackUrls =
      back_urls && back_urls.success
        ? back_urls
        : {
            success: FRONTEND_URL,
            failure: FRONTEND_URL,
            pending: FRONTEND_URL,
          };

    const preference = {
      items: [
        {
          title,
          quantity: 1,
          unit_price: Number(price),
          currency_id: currency || "ARS",
        },
      ],
      back_urls: finalBackUrls,
      auto_return: "approved",
      metadata: metadata || {},
    };

    const result = await mercadopago.preferences.create(preference);

    return res.json({
      ok: true,
      init_point: result.body.init_point,
      sandbox_init_point: result.body.sandbox_init_point,
    });
  } catch (err) {
    console.error("Error creando preferencia MP:", err);
    return res.status(500).json({
      ok: false,
      msg: "Error creando preferencia",
    });
  }
});

// ============================
// RECIBO — SUBIR COMPROBANTE
// ============================
const upload = multer({ storage: multer.memoryStorage() });

app.post(
  "/payments/upload-receipt",
  upload.single("file"),
  async (req, res) => {
    try {
      const { user_id, month } = req.body || {};
      const file = req.file;

      if (!user_id || !month) {
        return res.json({ ok: false, msg: "Faltan datos de usuario/mes" });
      }

      if (!file) {
        return res.json({ ok: false, msg: "No se envió archivo" });
      }

      const safeName = file.originalname.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const path = `receipts/${user_id}/${month}_${Date.now()}_${safeName}`;

      const { error: uploadErr } = await supabase.storage
        .from("payment_receipts")
        .upload(path, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (uploadErr) {
        console.error("Error subiendo recibo:", uploadErr);
        return res.json({ ok: false, msg: "No se pudo subir archivo" });
      }

      const {
        data: { publicUrl },
      } = supabase.storage.from("payment_receipts").getPublicUrl(path);

      // Registramos estado intermedio: comprobante cargado
      const { error: insertErr } = await supabase.from("payments").insert({
        user_id,
        month_year: month,
        status: "receipt_uploaded",
        receipt_url: publicUrl,
        amount: 0,
      });

      if (insertErr) {
        console.error("Error registrando pago/recibo:", insertErr);
        return res.json({
          ok: false,
          msg: "Recibo subido pero no se pudo registrar el pago",
        });
      }

      res.json({ ok: true });
    } catch (err) {
      console.error("Error /payments/upload-receipt:", err);
      res.json({ ok: false, msg: "Error interno" });
    }
  }
);

// ============================
// ADMIN — Cambiar estado de pago manualmente
// ============================
app.post("/admin/payment/set", async (req, res) => {
  try {
    const { user_id, status } = req.body || {};

    if (!user_id || !status) {
      return res.json({ ok: false, msg: "Faltan datos" });
    }

    const month = new Date().toISOString().slice(0, 7);

    const { error } = await supabase.from("payments").insert({
      user_id,
      month_year: month,
      status,
      amount: 0,
    });

    if (error) {
      console.error("Error admin/payment/set:", error);
      return res.json({ ok: false, msg: "Error actualizando pago" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error("Error general /admin/payment/set:", err);
    res.json({ ok: false, msg: "Error interno" });
  }
});

// ============================
// START SERVER
// ============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend PauPau corriendo en puerto ${PORT}`);
});
