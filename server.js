/* ============================================
   SERVER.JS FINAL — PAUPAU CAMPUS BACKEND
   - Cupón de descuento
   - Crear preferencia de pago en MP
   - Subir comprobante (desbloquea campus)
   - Admin: marcar pagado / pendiente
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

/* ============================
   CORS
   ============================ */
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // Postman / same-origin
      const allowed = (process.env.ALLOWED_ORIGIN || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (allowed.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error("CORS error: origin no permitido"));
    },
  })
);

/* ============================
   ENV VALIDATION
   ============================ */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const FRONTEND_URL_ENV = process.env.FRONTEND_URL; // https://www.paupaulanguages.com/campus

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error("❌ ERROR: SUPABASE_URL o SUPABASE_SERVICE_ROLE faltan en ENV");
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  console.error("❌ ERROR: MP_ACCESS_TOKEN faltando en ENV");
  process.exit(1);
}

/* ============================
   SUPABASE CLIENT (service role)
   ============================ */
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

/* ============================
   MERCADO PAGO CONFIG
   ============================ */
mercadopago.configure({
  access_token: MP_ACCESS_TOKEN,
});

/* ============================
   HEALTHCHECK (Render)
   ============================ */
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

/* ============================
   CUPÓN — VERIFICAR
   ============================ */
/*
  Body esperado:
  {
    "code": "nachoprueba",
    "user_id": "uuid-del-alumno"   // hoy no lo usamos, pero puede quedar
  }
*/
app.post("/coupon/apply", async (req, res) => {
  try {
    const { code } = req.body;

    if (!code) {
      return res.json({ ok: false, msg: "Falta código de cupón" });
    }

    const { data, error } = await supabase
      .from("coupons")
      .select("id, code, discount_percent, active")
      .eq("code", code)
      .eq("active", true)
      .maybeSingle();

    if (error || !data) {
      return res.json({
        ok: false,
        msg: "Cupón inválido o inactivo",
      });
    }

    return res.json({
      ok: true,
      discount_percent: data.discount_percent,
    });
  } catch (err) {
    console.error("Error en /coupon/apply:", err);
    return res.json({
      ok: false,
      msg: "Error interno al validar cupón",
    });
  }
});

/* ============================
   MERCADO PAGO – CREAR PREFERENCIA
   ============================ */
/*
  Body esperado desde el campus:
  {
    title: "Cuota mensual PauPau",
    price: 65000,
    currency: "ARS",
    back_urls: { ... }   // opcional
    metadata: { ... }    // opcional
  }
*/
app.post("/crear-preferencia", async (req, res) => {
  try {
    const { title, price, currency, back_urls, metadata } = req.body || {};

    if (!title || !price) {
      return res
        .status(400)
        .json({ ok: false, msg: "Falta título o precio en la preferencia" });
    }

    // URL del campus (inicialmente la de producción, pero si no está, usamos Netlify)
    const FRONTEND_URL =
      FRONTEND_URL_ENV || "https://famous-lily-8e39ce.netlify.app";

    // Si el frontend manda back_urls, las respetamos; si no, usamos siempre el campus
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
      msg: "Error creando preferencia en Mercado Pago",
    });
  }
});

/* ============================
   SUBIR COMPROBANTE DE PAGO
   (desbloquea el campus)
   ============================ */

const upload = multer({ storage: multer.memoryStorage() });

/*
  FormData esperado:
  - file: archivo
  - user_id: uuid de profiles
  - month: "YYYY-MM"
*/
app.post(
  "/payments/upload-receipt",
  upload.single("file"),
  async (req, res) => {
    try {
      const { user_id, month } = req.body;
      const file = req.file;

      if (!user_id || !month) {
        return res.json({
          ok: false,
          msg: "Faltan user_id o month",
        });
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
        console.error("Error subiendo a Storage:", uploadErr);
        return res.json({ ok: false, msg: "No se pudo subir el archivo" });
      }

      // URL pública del comprobante
      const {
        data: { publicUrl },
      } = supabase.storage.from("payment_receipts").getPublicUrl(path);

      // 👉 AQUÍ desbloqueamos el campus:
      // guardamos un registro en payments con status 'approved'
      const { error: payErr } = await supabase.from("payments").insert({
        user_id,
        month_year: month,
        status: "approved", // ESTE estado es el que el front usa para desbloquear
        receipt_url: publicUrl,
        amount: 0,
      });

      if (payErr) {
        console.error("Error guardando payment:", payErr);
        return res.json({
          ok: false,
          msg: "Se subió el archivo pero no se pudo guardar el pago",
        });
      }

      return res.json({
        ok: true,
        msg: "Comprobante subido y pago marcado como aprobado",
      });
    } catch (err) {
      console.error("Error en /payments/upload-receipt:", err);
      return res.json({ ok: false, msg: "Error interno subiendo comprobante" });
    }
  }
);

/* ============================
   ADMIN — Cambiar estado de pago
   ============================ */
/*
  Body esperado:
  {
    user_id: "uuid",
    status: "approved" | "pending" | "blocked" | lo que quieras
  }
  Esto genera un registro nuevo en payments para el mes actual.
*/
app.post("/admin/payment/set", async (req, res) => {
  try {
    const { user_id, status } = req.body;

    if (!user_id || !status) {
      return res.json({
        ok: false,
        msg: "Faltan user_id o status",
      });
    }

    const month = new Date().toISOString().slice(0, 7); // YYYY-MM

    const { error } = await supabase.from("payments").insert({
      user_id,
      month_year: month,
      status,
      amount: 0,
    });

    if (error) {
      console.error("Error en /admin/payment/set:", error);
      return res.json({ ok: false, msg: "Error actualizando pago" });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Error general en /admin/payment/set:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

/* ============================
   START SERVER
   ============================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Backend PauPau corriendo en puerto ${PORT}`);
});
