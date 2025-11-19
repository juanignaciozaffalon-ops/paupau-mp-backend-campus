// server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const mercadopago = require('mercadopago');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');

// ============================
// CONFIGURACIÓN BÁSICA
// ============================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Para subir archivos (comprobantes)
const upload = multer({ storage: multer.memoryStorage() });

// ============================
// MERCADO PAGO
// ============================
mercadopago.configure({
  access_token: process.env.MP_ACCESS_TOKEN
});

// ============================
// SUPABASE (service role)
// ============================
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // IMPORTANTE: service role, no anon
);

// ============================
// HELPERS
// ============================
function getCurrentBillingMonth() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1); // primer día del mes
}

function parseBillingMonth(str) {
  // Espera "YYYY-MM"
  const [year, month] = str.split('-').map(Number);
  return new Date(year, month - 1, 1);
}

function toISODate(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ============================
// ENDPOINT: Crear preferencia MP
// ============================
//
// Espera body:
// {
//   student_id: "uuid",
//   amount: 100,
//   currency: "ARS" (opcional),
//   coupon_code: "nachoprueba" (opcional),
//   billing_month: "2025-11" (opcional, si no se manda, usa mes actual)
// }
//
app.post('/api/payments/create-preference', async (req, res) => {
  try {
    const { student_id, amount, currency = 'ARS', coupon_code, billing_month } = req.body;

    if (!student_id || !amount) {
      return res.status(400).json({ error: 'student_id y amount son requeridos' });
    }

    const billingMonthDate = billing_month
      ? parseBillingMonth(billing_month)
      : getCurrentBillingMonth();

    const billingMonthISO = toISODate(billingMonthDate);

    let finalAmount = Number(amount);

    // ============================
    // 1) Validar cupón (si hay)
    // ============================
    let appliedCoupon = null;

    if (coupon_code) {
      const { data: coupon, error: couponError } = await supabase
        .from('coupons')
        .select('*')
        .eq('code', coupon_code)
        .eq('is_active', true)
        .maybeSingle();

      if (couponError) {
        console.error('Error buscando cupón:', couponError);
      } else if (coupon) {
        const today = new Date();
        const validFrom = coupon.valid_from ? new Date(coupon.valid_from) : null;
        const validUntil = coupon.valid_until ? new Date(coupon.valid_until) : null;

        const isValidDate =
          (!validFrom || today >= validFrom) &&
          (!validUntil || today <= validUntil);

        if (isValidDate) {
          const discount = (finalAmount * Number(coupon.discount_percent)) / 100;
          finalAmount = Math.max(0, finalAmount - discount);
          appliedCoupon = coupon.code;
        }
      }
    }

    // ============================
    // 2) Anti doble pago
    // ============================
    const { data: existingPayment, error: existingError } = await supabase
      .from('payments')
      .select('*')
      .eq('student_id', student_id)
      .eq('billing_month', billingMonthISO)
      .maybeSingle();

    if (existingError) {
      console.error('Error buscando payment existente:', existingError);
    }

    if (
      existingPayment &&
      ['receipt_uploaded', 'approved'].includes(existingPayment.status)
    ) {
      return res.status(400).json({
        error:
          'Ya tenés un pago con comprobante registrado para este mes. Si hay un error, comunicate con administración.'
      });
    }

    // Crear o actualizar el registro de pago del mes
    let paymentId = existingPayment ? existingPayment.id : null;

    if (!paymentId) {
      const { data: inserted, error: insertError } = await supabase
        .from('payments')
        .insert({
          student_id,
          billing_month: billingMonthISO,
          amount: finalAmount,
          currency,
          status: 'pending',
          coupon_code: appliedCoupon
        })
        .select()
        .maybeSingle();

      if (insertError) {
        console.error('Error creando payment:', insertError);
        return res.status(500).json({ error: 'No se pudo crear el pago' });
      }

      paymentId = inserted.id;
    } else {
      // Actualizar datos si ya existía
      const { error: updateError } = await supabase
        .from('payments')
        .update({
          amount: finalAmount,
          currency,
          coupon_code: appliedCoupon
        })
        .eq('id', paymentId);

      if (updateError) {
        console.error('Error actualizando payment:', updateError);
      }
    }

    // Si el monto quedó en 0 (por cupón del 100%), no creamos preferencia MP
    if (finalAmount === 0) {
      // Marcamos como "paid" directamente
      const { error: zeroPayError } = await supabase
        .from('payments')
        .update({ status: 'paid' })
        .eq('id', paymentId);

      if (zeroPayError) {
        console.error('Error marcando pago 0 como paid:', zeroPayError);
        return res.status(500).json({ error: 'No se pudo marcar el pago como paid' });
      }

      return res.json({
        init_point: null,
        message: 'Cuota cubierta por cupón. Por favor, subí el comprobante si corresponde.'
      });
    }

    // ============================
    // 3) Crear preferencia en MP
    // ============================
    const preference = {
      items: [
        {
          title: 'Cuota mensual Campus PauPau',
          quantity: 1,
          unit_price: Number(finalAmount),
          currency_id: currency
        }
      ],
      metadata: {
        student_id,
        payment_id: paymentId,
        billing_month: billingMonthISO
      },
      notification_url: process.env.MP_WEBHOOK_URL,
      back_urls: {
        success: process.env.MP_SUCCESS_URL,
        failure: process.env.MP_FAILURE_URL,
        pending: process.env.MP_PENDING_URL
      },
      auto_return: 'approved'
    };

    const mpResponse = await mercadopago.preferences.create(preference);

    return res.json({
      init_point: mpResponse.body.init_point,
      id: mpResponse.body.id
    });
  } catch (err) {
    console.error('Error en create-preference:', err);
    return res.status(500).json({ error: 'Error interno al crear preferencia' });
  }
});

// ============================
// WEBHOOK MP: marca status = 'paid'
// ============================
app.post('/api/payments/mp-webhook', async (req, res) => {
  try {
    const { type, data } = req.body;

    if (type !== 'payment') {
      return res.status(200).send('ok');
    }

    const paymentId = data.id;

    const paymentInfo = await mercadopago.payment.findById(paymentId);

    const mpData = paymentInfo.body;

    if (mpData.status === 'approved') {
      const metadata = mpData.metadata || {};
      const payment_id = metadata.payment_id;
      const student_id = metadata.student_id;
      const billing_month = metadata.billing_month;

      if (!payment_id || !student_id || !billing_month) {
        console.error('Metadata incompleta en MP:', metadata);
      } else {
        const { error: updateError } = await supabase
          .from('payments')
          .update({
            status: 'paid',
            mp_payment_id: String(paymentId),
            updated_at: new Date().toISOString()
          })
          .eq('id', payment_id);

        if (updateError) {
          console.error('Error actualizando payment a paid:', updateError);
        }
      }
    }

    res.status(200).send('ok');
  } catch (err) {
    console.error('Error en mp-webhook:', err);
    res.status(500).send('error');
  }
});

// ============================
// SUBIDA DE COMPROBANTE:
// Desbloquea automáticamente el campus
// ============================
//
// FormData:
// - student_id
// - billing_month (YYYY-MM)
// - file (campo "receipt")
//
app.post('/api/payments/upload-receipt', upload.single('receipt'), async (req, res) => {
  try {
    const { student_id, billing_month } = req.body;
    const file = req.file;

    if (!student_id || !billing_month || !file) {
      return res.status(400).json({ error: 'student_id, billing_month y archivo son requeridos' });
    }

    const billingMonthDate = parseBillingMonth(billing_month);
    const billingMonthISO = toISODate(billingMonthDate);

    // Buscar o crear payment del mes
    const { data: existingPayment, error: existingError } = await supabase
      .from('payments')
      .select('*')
      .eq('student_id', student_id)
      .eq('billing_month', billingMonthISO)
      .maybeSingle();

    if (existingError) {
      console.error('Error buscando payment en upload-receipt:', existingError);
      return res.status(500).json({ error: 'Error interno al buscar payment' });
    }

    let paymentId = existingPayment ? existingPayment.id : null;

    if (!paymentId) {
      // Si no existía, lo creamos con amount 0 (por ejemplo, pago en efectivo)
      const { data: inserted, error: insertError } = await supabase
        .from('payments')
        .insert({
          student_id,
          billing_month: billingMonthISO,
          amount: 0,
          currency: 'USD',
          status: 'pending'
        })
        .select()
        .maybeSingle();

      if (insertError) {
        console.error('Error creando payment en upload-receipt:', insertError);
        return res.status(500).json({ error: 'No se pudo crear el registro de pago' });
      }

      paymentId = inserted.id;
    }

    // Subir a Supabase Storage (bucket "receipts")
    const ext = path.extname(file.originalname) || '.pdf';
    const filePath = `${student_id}/${billingMonthISO}_${Date.now()}${ext}`;

    const { data: storageData, error: storageError } = await supabase.storage
      .from('receipts')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true
      });

    if (storageError) {
      console.error('Error subiendo archivo a storage:', storageError);
      return res.status(500).json({ error: 'No se pudo subir el comprobante' });
    }

    // URL pública
    const { data: publicUrlData } = supabase.storage
      .from('receipts')
      .getPublicUrl(storageData.path);

    const publicUrl = publicUrlData.publicUrl;

    // Actualizar payment: marcar como receipt_uploaded y desbloquear
    const { error: updateError } = await supabase
      .from('payments')
      .update({
        status: 'receipt_uploaded',
        receipt_url: publicUrl,
        updated_at: new Date().toISOString()
      })
      .eq('id', paymentId);

    if (updateError) {
      console.error('Error actualizando payment con comprobante:', updateError);
      return res.status(500).json({ error: 'No se pudo actualizar el registro de pago' });
    }

    return res.json({
      message: 'Comprobante subido correctamente. Tu acceso al campus ya está habilitado.',
      receipt_url: publicUrl
    });
  } catch (err) {
    console.error('Error en upload-receipt:', err);
    return res.status(500).json({ error: 'Error interno al subir comprobante' });
  }
});

// ============================
// ESTADO DEL ALUMNO (bloqueo día 7)
// ============================
//
// GET /api/payments/status/:student_id
//
app.get('/api/payments/status/:student_id', async (req, res) => {
  try {
    const { student_id } = req.params;
    const now = new Date();
    const billingMonthDate = getCurrentBillingMonth();
    const billingMonthISO = toISODate(billingMonthDate);

    const day = now.getDate();

    const { data: payment, error: paymentError } = await supabase
      .from('payments')
      .select('*')
      .eq('student_id', student_id)
      .eq('billing_month', billingMonthISO)
      .maybeSingle();

    if (paymentError) {
      console.error('Error obteniendo payment status:', paymentError);
      return res.status(500).json({ error: 'Error obteniendo estado de pago' });
    }

    let isBlocked = false;
    let status = payment ? payment.status : 'pending';
    let message = '';

    const hasUnlockedStatus =
      payment && ['receipt_uploaded', 'approved'].includes(payment.status);

    if (hasUnlockedStatus) {
      isBlocked = false;
      message = 'Tu pago está al día y tu acceso al campus está habilitado.';
    } else {
      // No hay comprobante cargado
      if (!payment || payment.status === 'pending') {
        if (day <= 7) {
          isBlocked = false;
          message =
            'Recordá realizar tu pago y subir el comprobante antes del día 7 para mantener el acceso al campus.';
        } else {
          isBlocked = true;
          message =
            'Tu acceso está bloqueado porque no registramos pago con comprobante para este mes. Realizá el pago y subí el comprobante para reactivar el campus.';
        }
      } else if (payment.status === 'paid') {
        // MP pagado pero sin comprobante
        if (day <= 7) {
          isBlocked = false;
          message =
            'Pago recibido. Subí el comprobante para completar el proceso y asegurar tu acceso al campus.';
        } else {
          isBlocked = true;
          message =
            'Tu pago por MP está registrado, pero falta subir el comprobante. Subilo para reactivar tu acceso.';
        }
      } else {
        // Otros estados raros
        isBlocked = day > 7;
        message =
          'No se pudo determinar correctamente tu estado de pago. Si ves algo raro, contactá a administración.';
      }
    }

    return res.json({
      student_id,
      billing_month: billingMonthISO,
      status,
      isBlocked,
      message
    });
  } catch (err) {
    console.error('Error en status:', err);
    return res.status(500).json({ error: 'Error interno al obtener estado' });
  }
});

// ============================
// LISTADO PARA ADMIN (COMPROBANTES)
// ============================
//
// GET /api/admin/receipts?month=YYYY-MM
//
app.get('/api/admin/receipts', async (req, res) => {
  try {
    const { month } = req.query;

    if (!month) {
      return res.status(400).json({ error: 'month (YYYY-MM) es requerido' });
    }

    const billingMonthDate = parseBillingMonth(month);
    const billingMonthISO = toISODate(billingMonthDate);

    const { data, error } = await supabase
      .from('payments')
      .select('*')
      .eq('billing_month', billingMonthISO)
      .not('receipt_url', 'is', null)
      .order('updated_at', { ascending: false });

    if (error) {
      console.error('Error listando comprobantes:', error);
      return res.status(500).json({ error: 'Error listando comprobantes' });
    }

    return res.json({ data });
  } catch (err) {
    console.error('Error en /admin/receipts:', err);
    return res.status(500).json({ error: 'Error interno' });
  }
});

// ============================
// START
// ============================
app.get('/', (req, res) => {
  res.send('Campus PauPau backend running');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
