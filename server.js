/* ============================================
   SERVER.JS FINAL — PAUPAU CAMPUS BACKEND
   Cupón + MP + comprobantes + upsert pagos
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
        return callback(new Error("CORS error: bad config"));
      }
    },
  })
);

// ============================
// ENV & SUPABASE
// ============================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PORT = process.env.PORT || 3000;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  console.error(
    "❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE en variables de entorno"
  );
  process.exit(1);
}

if (!MP_ACCESS_TOKEN) {
  console.warn("⚠️ No hay MP_ACCESS_TOKEN; las rutas de MP no funcionarán.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ============================
// MULTER (para comprobantes)
// ============================
const storage = multer.memoryStorage();
const upload = multer({ storage });

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
// ============================
// Body: { code: "nachoprueba" }
app.post("/coupon/apply", async (req, res) => {
  try {
    const { code } = req.body || {};
    if (!code) {
      return res.status(400).json({ ok: false, msg: "Falta código de cupón" });
    }

    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("coupons")
      .select("*")
      .eq("code", code)
      .eq("active", true)
      .lte("valid_from", now)
      .gte("valid_to", now)
      .limit(1)
      .single();

    if (error) {
      console.error("Error buscando cupón:", error);
      return res
        .status(500)
        .json({ ok: false, msg: "Error interno al buscar cupón" });
    }

    if (!data) {
      return res.json({ ok: false, msg: "Cupón no válido o inactivo" });
    }

    return res.json({
      ok: true,
      discount_percent: data.discount_percent || 0,
      coupon: data,
    });
  } catch (err) {
    console.error("Error /coupon/apply:", err);
    return res.status(500).json({ ok: false, msg: "Error interno" });
  }
});

// ============================
// MERCADO PAGO – CREAR PREFERENCIA
// ============================

const createPreferenceHandler = async (req, res) => {
  try {
    const {
      title,
      quantity,
      unit_price,
      back_url_success,
      back_url_failure,
      coupon_code,
    } = req.body || {};

    if (!title || !quantity || !unit_price) {
      return res
        .status(400)
        .json({ ok: false, msg: "Faltan campos en la preferencia" });
    }

    let finalAmount = unit_price * quantity;
    let discountPercent = 0;
    let couponData = null;

    if (coupon_code) {
      const now = new Date().toISOString();
      const { data: coupon, error: couponErr } = await supabase
        .from("coupons")
        .select("*")
        .eq("code", coupon_code)
        .eq("active", true)
        .lte("valid_from", now)
        .gte("valid_to", now)
        .limit(1)
        .single();

      if (couponErr) {
        console.error("Error consultando cupón para preferencia:", couponErr);
      } else if (coupon) {
        discountPercent = coupon.discount_percent || 0;
        couponData = coupon;
        finalAmount = finalAmount * (1 - discountPercent / 100);
      }
    }

    const preference = {
      items: [
        {
          title,
          quantity,
          unit_price: Number(finalAmount.toFixed(2)),
          currency_id: "ARS",
        },
      ],
      back_urls: {
        success: back_url_success || "https://paupaulanguages.com",
        failure: back_url_failure || "https://paupaulanguages.com",
      },
      auto_return: "approved",
    };

    const result = await mercadopago.preferences.create(preference);

    return res.json({
      ok: true,
      id: result.body.id,
      init_point: result.body.init_point,
      sandbox_init_point: result.body.sandbox_init_point,
      final_amount: finalAmount,
      discount_percent: discountPercent,
      coupon: couponData,
    });
  } catch (err) {
    console.error("Error creando preferencia MP:", err);
    return res.status(500).json({ ok: false, msg: "Error interno" });
  }
};

// Ruta nueva y ruta vieja (por compatibilidad)
app.post("/mp/create-preference", createPreferenceHandler);
app.post("/crear-preferencia", createPreferenceHandler);

// =====================================================
// PAGOS — SUBIR COMPROBANTE Y REGISTRAR PAGO EN TABLA
// =====================================================
// Body (form-data):
// - file: (archivo)
// - user_id: uuid del alumno
// - month: "YYYY-MM" (ej: "2025-11")
app.post(
  "/payments/upload-receipt",
  upload.single("file"),
  async (req, res) => {
    try {
      const { user_id, month } = req.body || {};
      const file = req.file;

      if (!user_id || !month) {
        return res.json({
          ok: false,
          msg: "Faltan user_id o month en el formulario.",
        });
      }

      if (!file) {
        return res.json({
          ok: false,
          msg: "No se recibió archivo para el comprobante.",
        });
      }

      // 1) Subir archivo a Supabase Storage
      const fileExt = file.originalname.split(".").pop();
      const fileName = `${user_id}/${month}-${Date.now()}.${fileExt}`;
      const bucket = "payment_receipts";

      const { error: uploadError } = await supabase.storage
        .from(bucket)
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (uploadError) {
        console.error("Error subiendo archivo Storage:", uploadError);
        return res.json({
          ok: false,
          msg: "No se pudo subir el archivo de comprobante.",
        });
      }

      // 2) Obtener la URL pública
      const { data: publicData } = supabase.storage
        .from(bucket)
        .getPublicUrl(fileName);

      const publicUrl = publicData?.publicUrl || null;

      // 3) Upsert en la tabla payments (user_id + month_year único)
      const monthYear = month; // "YYYY-MM"
      const { error: payErr } = await supabase.from("payments").upsert(
        {
          user_id,
          month_year: monthYear,
          status: "receipt_uploaded",
          receipt_url: publicUrl,
          amount: 0, // el admin después puede actualizar, pero nunca será NULL
          receipt_uploaded_at: new Date().toISOString(),
          source: "receipt_upload",
        },
        {
          onConflict: "user_id,month_year",
        }
      );

      if (payErr) {
        console.error("Error guardando pago:", payErr);
        return res.json({
          ok: false,
          msg: "Recibo subido pero no se pudo registrar el pago en la tabla.",
        });
      }

      return res.json({ ok: true, url: publicUrl });
    } catch (err) {
      console.error("Error /payments/upload-receipt:", err);
      return res.json({ ok: false, msg: "Error interno" });
    }
  }
);

// =====================================================
// ADMIN — OBTENER PAGOS DE UN ALUMNO (COMPROBANTES)
// =====================================================
// Query: ?user_id=...&month=YYYY-MM (mes opcional)
app.get("/admin/payments/user", async (req, res) => {
  try {
    const { user_id, month } = req.query || {};
    if (!user_id) {
      return res.json({ ok: false, msg: "Falta user_id" });
    }

    let query = supabase.from("payments").select("*").eq("user_id", user_id);

    if (month) {
      query = query.eq("month_year", month);
    }

    const { data, error } = await query.order("month_year", {
      ascending: false,
    });

    if (error) {
      console.error("Error admin/payments/user:", error);
      return res.json({ ok: false, msg: "Error consultando pagos" });
    }

    return res.json({ ok: true, payments: data || [] });
  } catch (err) {
    console.error("Error general /admin/payments/user:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// =====================================================
// ADMIN — RESUMEN PAGOS MES ACTUAL
// =====================================================
// Query: ?month=YYYY-MM
app.get("/admin/payments/summary", async (req, res) => {
  try {
    const { month } = req.query || {};
    const monthYear = month || new Date().toISOString().slice(0, 7);

    const { data, error } = await supabase
      .from("payments")
      .select("*")
      .eq("month_year", monthYear)
      .order("updated_at", { ascending: false });

    if (error) {
      console.error("Error admin/payments/summary:", error);
      return res.json({ ok: false, msg: "Error consultando resumen" });
    }

    return res.json({ ok: true, payments: data || [] });
  } catch (err) {
    console.error("Error general /admin/payments/summary:", err);
    return res.json({ ok: false, msg: "Error interno" });
  }
});

// =====================================================
// ADMIN — Cambiar estado de pago manualmente (UPSERT)
// =====================================================
app.post("/admin/payment/set", async (req, res) => {
  try {
    const { user_id, status, month } = req.body || {};

    if (!user_id || !status) {
      return res.json({ ok: false, msg: "Faltan user_id o status." });
    }

    const monthYear = month || new Date().toISOString().slice(0, 7); // YYYY-MM

    // 1) Buscar registro existente para recuperar amount
    const { data: existing, error: fetchError } = await supabase
      .from("payments")
      .select("amount")
      .eq("user_id", user_id)
      .eq("month_year", monthYear)
      .maybeSingle();

    if (fetchError) {
      console.error("Error buscando pago existente:", fetchError);
      return res.json({ ok: false, msg: "Error buscando pago existente." });
    }

    // Si existe, usamos el amount de la fila. Si no, usamos 0 como default.
    const amount = existing?.amount ?? 0;

    // 2) Upsert con amount incluido (no puede ser NULL)
    const { error } = await supabase
      .from("payments")
      .upsert(
        {
          user_id,
          month_year: monthYear,
          status, // "approved" o "pending"
          amount,
        },
        {
          onConflict: "user_id,month_year",
        }
      );

    if (error) {
      console.error("Error admin/payment/set:", error);
      return res.json({ ok: false, msg: "Error actualizando estado de pago." });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("Exception en /admin/payment/set:", err);
    return res.json({ ok: false, msg: "Error inesperado." });
  }
});

// ============================
// START SERVER
// ============================
app.listen(PORT, () => {
  console.log(`🚀 Backend PauPau corriendo en puerto ${PORT}`);
});
