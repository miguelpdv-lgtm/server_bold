import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

// ─── Supabase ─────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3001;

// ─── Validar env ──────────────────────────────────────────────────────────────
if (!process.env.BOLD_SECRET_KEY)           console.error("❌ Falta BOLD_SECRET_KEY");
if (!process.env.SUPABASE_URL)              console.error("❌ Falta SUPABASE_URL");
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) console.error("❌ Falta SUPABASE_SERVICE_ROLE_KEY");

// ─── Webhook de Bold ──────────────────────────────────────────────────────────
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const receivedSig = req.headers["x-bold-signature"];
    if (!receivedSig) return res.status(400).send("Falta firma");

    const bodyBase64 = req.body.toString("base64");
    const secretKey = process.env.BOLD_WEBHOOK_SECRET ?? "";

    const hashed = crypto
      .createHmac("sha256", secretKey)
      .update(bodyBase64)
      .digest("hex");

    const isValid = crypto.timingSafeEqual(
      Buffer.from(hashed),
      Buffer.from(receivedSig)
    );

    if (!isValid) {
      console.error("❌ Firma inválida del webhook");
      return res.status(400).send("Firma inválida");
    }

    const payload = JSON.parse(req.body.toString("utf-8"));
    console.log("📬 Webhook recibido:", payload.type);

    if (payload.type === "SALE_APPROVED") {
      const payment_id = payload.data?.payment_id;
      const order_id = payload.data?.metadata?.reference;

      console.log("🔍 order_id:", order_id, "| payment_id:", payment_id);

      const { error } = await supabase
        .from("orders")
        .update({
          estado_pago: "pagado",
          bold_transaction_id: payment_id,
          pagado_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("bold_order_id", order_id);

      if (error) {
        console.error("❌ Error actualizando orden:", error.message);
      } else {
        console.log(`✅ Orden ${order_id} marcada como pagada. TX: ${payment_id}`);
      }
    }

    if (payload.type === "SALE_REJECTED") {
      const order_id = payload.data?.metadata?.reference;

      console.log("🔍 order_id rechazado:", order_id);

      const { error } = await supabase
        .from("orders")
        .update({
          estado_pago: "error",
          updated_at: new Date().toISOString(),
        })
        .eq("bold_order_id", order_id);

      if (error) {
        console.error("❌ Error actualizando orden rechazada:", error.message);
      } else {
        console.log(`❌ Orden ${order_id} marcada como error.`);
      }
    }

    return res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Error en webhook:", err.message);
    return res.status(500).send("Error interno");
  }
});

// ─── Parser JSON ──────────────────────────────────────────────────────────────
app.use(express.json());

// ─── Generar firma de integridad ──────────────────────────────────────────────
function generateSignature(orderId, amount, currency) {
  const secret = process.env.BOLD_SECRET_KEY;
  const raw = `${orderId}${amount}${currency}${secret}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

// ─── Crear orden ──────────────────────────────────────────────────────────────
app.post("/create-order", async (req, res) => {
  try {
    const {
      nombre_completo,
      email,
      telefono,
      direccion,
      barrio,
      items,
      envio,
    } = req.body;

    if (!items || items.length === 0) {
      return res.status(400).json({ error: "No hay productos" });
    }

    const subtotal = items.reduce(
      (acc, item) => acc + item.price * item.quantity,
      0
    );
    const total = subtotal + (envio || 0);
    const orderId = `ORDER_${Date.now()}`;
    const amount = String(total);
    const signature = generateSignature(orderId, amount, "COP");

    const { error: dbError } = await supabase.from("orders").insert({
      bold_order_id: orderId,
      nombre_completo,
      email,
      telefono,
      direccion: direccion || "",
      barrio: barrio || "",
      items,
      subtotal,
      envio: envio || 0,
      total,
      estado_pago: "pendiente",
    });

    if (dbError) {
      console.error("❌ Error guardando orden:", dbError.message);
    } else {
      console.log("💾 Orden guardada:", orderId);
    }

    res.json({
      orderId,
      amount,
      currency: "COP",
      integritySignature: signature,
      description: `Compra tienda - ${nombre_completo}`,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error creando orden" });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.send("🚀 Servidor Emarizos corriendo");
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en puerto ${PORT}`);
});
