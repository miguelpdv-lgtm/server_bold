// ─── Webhook de Bold ──────────────────────────────────────────────────────────
app.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  // ✅ Siempre responder 200 primero — Bold no debe esperar ni recibir 500
  res.status(200).send("OK");

  try {
    const rawBody = req.body.toString("utf-8");
    const payload = JSON.parse(rawBody);

    console.log("📬 Webhook recibido:", payload.type);

    if (payload.type === "SALE_APPROVED") {
      const { payment_id, order_id } = extractBoldIds(payload);
      const integration = payload?.data?.integration ?? null;
      const amount = payload?.data?.amount?.total ?? null;
      const created_at = payload?.data?.created_at ?? null;

      console.log("🔍 order_id:", order_id, "| payment_id:", payment_id, "| integration:", integration);

      // ── Pagos de datáfono físico: solo loggear, no procesar ──────────────
      // integration === "POS" indica datáfono. Sin order_id no hay forma
      // de vincular con un pedido web, así que se registra y se ignora.
      if (integration === "POS" || (!order_id && payment_id)) {
        console.log(`🏪 Pago POS recibido — payment_id: ${payment_id} | monto: ${amount} COP | ignorado (no es pedido web)`);
        return;
      }

      // ── A partir de aquí solo llegan pagos del Botón de Pagos ────────────
      const pedido = await findOrder({ order_id, payment_id });

      if (!pedido) {
        console.warn("⚠️ Pedido web no encontrado:", { order_id, payment_id });
        return;
      }

      const resolvedOrderId = pedido.bold_order_id;

      if (pedido.estado_pago === "pagado" || pedido.estado_pago === "sincronizado") {
        console.log(`⏭️ Pedido ${resolvedOrderId} ya procesado, se omite`);
        return;
      }

      const updatePayload: Record<string, any> = {
        estado_pago: "pagado",
        pagado_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      if (payment_id && !pedido.bold_transaction_id) {
        updatePayload.bold_transaction_id = payment_id;
      }

      const { error: updateError } = await supabase
        .from("orders")
        .update(updatePayload)
        .eq("id", pedido.id);

      if (updateError) {
        // ✅ Solo log — no lanzar error que pueda romper el flujo
        console.error("❌ Error actualizando orden:", updateError.message);
        return;
      }

      console.log(`✅ Orden ${resolvedOrderId} marcada como pagada. TX: ${payment_id}`);

      // ── Correos ───────────────────────────────────────────────────────────
      try {
        const emailFrom = process.env.EMAIL_FROM;
        const adminEmail = process.env.ADMIN_EMAIL;
        const correosAEnviar = [];

        if (pedido.email) {
          correosAEnviar.push(
            resend.emails.send({
              from: `Emarizos <${emailFrom}>`,
              to: pedido.email,
              subject: `Confirmacion de tu pedido en Emarizos - ${resolvedOrderId}`,
              html: buildClienteHTML(pedido, resolvedOrderId),
            }).then(({ data, error }) => {
              if (error) console.error("❌ Error correo cliente:", error);
              else console.log(`✅ Correo cliente enviado a ${pedido.email} (ID: ${data?.id})`);
            })
          );
        } else {
          console.log(`⚠️ Orden ${resolvedOrderId} sin email de cliente.`);
        }

        if (adminEmail) {
          correosAEnviar.push(
            resend.emails.send({
              from: `Sistema Emarizos <${emailFrom}>`,
              to: adminEmail,
              subject: `Nuevo pedido pagado - ${resolvedOrderId}`,
              html: buildAdminHTML(pedido, resolvedOrderId, payment_id),
            }).then(({ data, error }) => {
              if (error) console.error("❌ Error correo admin:", error);
              else console.log(`✅ Correo admin enviado a ${adminEmail} (ID: ${data?.id})`);
            })
          );
        }

        await Promise.all(correosAEnviar);
      } catch (emailErr: any) {
        console.error("❌ Error enviando correos:", emailErr.message);
        // ✅ No relanzar — los correos no deben detener el flujo
      }

      // ── AgendaPro ─────────────────────────────────────────────────────────
      try {
        const productos = (pedido.items || []).map((item: any) => ({
          nombre: item.nombre ?? item.name,
          cantidad: item.cantidad ?? item.quantity,
        }));

        const agendaRes = await fetch(`${process.env.AGENDAPRO_BOT_URL}/venta`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": process.env.AGENDAPRO_BOT_API_KEY,
          },
          body: JSON.stringify({
            order_id: resolvedOrderId,
            payment_id,
            productos,
            cliente: {
              nombre_completo: pedido.nombre_completo,
              email: pedido.email,
              telefono: pedido.telefono,
            },
          }),
        });

        let agendaData = null;
        try { agendaData = await agendaRes.json(); } catch { agendaData = null; }

        if (!agendaRes.ok) throw new Error(`AgendaPro HTTP ${agendaRes.status}`);

        console.log("✅ Respuesta AgendaPro:", agendaData);

        const agendaOk = agendaData?.ok === true;
        const fueSoloEncolado = String(agendaData?.mensaje || "").toLowerCase().includes("encolada");

        if (agendaOk) {
          await supabase.from("orders").update({
            r_agendapro: true,
            updated_at: new Date().toISOString(),
          }).eq("id", pedido.id);

          if (fueSoloEncolado) {
            console.log(`⏳ Pedido ${resolvedOrderId} encolado en AgendaPro`);
          } else {
            await supabase.from("orders").update({
              estado_pago: "sincronizado",
              updated_at: new Date().toISOString(),
            }).eq("id", pedido.id);

            console.log(`✅ Pedido ${resolvedOrderId} sincronizado con AgendaPro`);
          }
        } else {
          throw new Error(agendaData?.mensaje || "Respuesta no válida de AgendaPro");
        }
      } catch (agendaErr: any) {
        console.error("❌ Error llamando AgendaPro:", agendaErr.message);

        await supabase.from("orders").update({
          agendapro_error: agendaErr.message,
          updated_at: new Date().toISOString(),
        }).eq("id", pedido.id).catch((e: any) => {
          console.error("❌ Error guardando agendapro_error:", e.message);
        });
        // ✅ No relanzar
      }
    }

    if (payload.type === "SALE_REJECTED") {
      const { order_id } = extractBoldIds(payload);
      const integration = payload?.data?.integration ?? null;

      // Ignorar rechazos del datáfono también
      if (integration === "POS" || !order_id) {
        console.log(`🏪 Rechazo POS ignorado — order_id: ${order_id ?? "null"}`);
        return;
      }

      const { error } = await supabase
        .from("orders")
        .update({ estado_pago: "error", updated_at: new Date().toISOString() })
        .eq("bold_order_id", order_id);

      if (error) console.error("❌ Error actualizando orden rechazada:", error.message);
      else console.log(`❌ Orden ${order_id} marcada como error.`);
    }

  } catch (err: any) {
    // ✅ Catch global — loggear sin responder 500 (ya respondimos 200 arriba)
    console.error("❌ Error en webhook:", err.message);
  }
});
