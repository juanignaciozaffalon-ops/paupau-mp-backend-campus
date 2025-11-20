/* ============================================
   SERVER.JS FINAL — PAUPAU CAMPUS BACKEND
   Totalmente corregido para tus variables Render
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
      if (!origin) return callback(null, true);
      if (process.env.ALLOWED_ORIGIN.split(",").includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS error"));
    },
  })
);

// ============================
// ENV VALIDATION
// ============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const FRONTEND_URL = process.env.FRONTEND_URL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("❌ ERROR: SUPABASE_URL o SUPABASE_SERVICE_ROLE faltan en ENV");
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  console.error("❌ ERROR: MP_ACCESS_TOKEN faltando");
  process.exit(1);
}

// ============================
// SUPABASE CLIENT
// ============================
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ============================
// MERCADO PAGO CONFIG
// ============================
mercadopago.configure({
  access_token: MP_ACCESS_TOKEN,
});

// ============================
// CUPÓN — VERIFICAR
// ============================
app.post("/coupon/apply", async (req, res) => {
  const { code, user_id } = req.body;

  const { data, error } = await supabase
    .from("coupons")
    .select("*")
    .eq("code", code)
    .eq("active", true)
    .maybeSingle();

  if (error || !data) {
    return res.json({
      ok: false,
      msg: "Cupón inválido o inactivo",
    });
  }

  res.json({
    ok: true,
    discount_percent: data.discount_percent,
  });
});

// ============================
// MERCADO PAGO – CREAR PREFERENCIA
// ============================
app.post("/crear-preferencia", async (req, res) => {
  try {
    const { title, price, metadata } = req.body;

    const mpBody = {
      items: [
        {
          title,
          unit_price: Number(price),
          quantity: 1,
        },
      ],
      back_urls: {
        success: FRONTEND_URL,
        pending: FRONTEND_URL,
        failure: FRONTEND_URL,
      },
      metadata,
      auto_return: "approved",
    };

    const preference = await mercadopago.preferences.create(mpBody);
    res.json({ ok: true, init_point: preference.body.init_point });
  } catch (err) {
    console.error("❌ Error creando preferencia:", err);
    res.json({ ok: false, msg: "Error iniciando pago" });
  }
});

// ============================
// RECIBO — SUBIR COMPROBANTE
// ============================
const upload = multer({ storage: multer.memoryStorage() });

app.post("/payments/upload-receipt", upload.single("file"), async (req, res) => {
  try {
    const { user_id, month } = req.body;
    const file = req.file;

    if (!file) return res.json({ ok: false, msg: "No se envió archivo" });

    const path = `receipts/${user_id}/${month}_${Date.now()}_${file.originalname}`;

    const { error: uploadErr } = await supabase.storage
      .from("payment_receipts")
      .upload(path, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadErr) {
      console.error(uploadErr);
      return res.json({ ok: false, msg: "No se pudo subir archivo" });
    }

    // URL pública
    const {
      data: { publicUrl },
    } = supabase.storage.from("payment_receipts").getPublicUrl(path);

    // Registrar pago con estado "receipt_uploaded"
    await supabase.from("payments").insert({
      user_id,
      month_year: month,
      status: "receipt_uploaded",
      receipt_url: publicUrl,
      amount: 0,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false, msg: "Error interno" });
  }
});

// ============================
// ADMIN — Cambiar estado de pago
// ============================
app.post("/admin/payment/set", async (req, res) => {
  try {
    const { user_id, status } = req.body;

    const { error } = await supabase.from("payments").insert({
      user_id,
      month_year: new Date().toISOString().slice(0, 7),
      status,
      amount: 0,
    });

    if (error) {
      console.error(error);
      return res.json({ ok: false, msg: "Error actualizando pago" });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

// ============================
// START SERVER
// ============================
app.listen(3000, () => {
  console.log("🚀 Backend PauPau corriendo en puerto 3000");
});
