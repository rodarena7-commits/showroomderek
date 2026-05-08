require('dotenv').config();
const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

let lastQR = "";
let sock;

const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

// ============================================================
// NÚMERO DUEÑO — recibe el resumen diario a las 18hs
// ============================================================
const NUMERO_DUENO = "541123484720@s.whatsapp.net"; // +5491123484720

// ============================================================
// GRUPO DE CONFIGURACIÓN — donde el dueño escribe restricciones
// ============================================================
const NOMBRE_GRUPO_CONFIG = "configuracion"; // Nombre del grupo privado
let grupoConfigId = null; // Se detecta automáticamente

// ============================================================
// STOCK DISPONIBLE — se actualiza desde un chat consigo mismo
// ============================================================
let stockDisponible = {};

// ============================================================
// ESTADO DE ATENCIÓN — si se toman pedidos hoy o no
// ============================================================
let estadoAtencion = "abierto"; // "abierto" o "cerrado"
let mensajeEstadoCerrado = ""; // Mensaje personalizado si está cerrado

// ============================================================
// CONTEXTO DEL DUEÑO — restricciones e instrucciones del día
// ============================================================
let contextoDueño = ""; // Se actualiza con IA a partir de mensajes del dueño
const mensajesConfiguracion = new Map(); // messageId → { tipo, contenido, contexto }
// tipo: "restriccion" o "stock"

// ============================================================
// PEDIDOS DEL DÍA — se acumulan hasta el envío de las 18hs
// ============================================================
let pedidosDelDia = []; // Array de objetos de pedido confirmado

// ============================================================
// HISTORIAL DE CONVERSACIÓN POR CLIENTE
// ============================================================
const conversaciones = new Map(); // jid → array de mensajes

// ============================================================
// LISTA DE PRECIOS
// ============================================================
const LISTA_DE_PRECIOS = `
=== CARNES BOVINAS ===
Asado de tira: $8.500/kg
Vacío: $9.200/kg
Bife ancho (con tapa): $12.500/kg
Bife angosto / Bife de chorizo: $13.000/kg
Bife ancho sin tapa / Ojo de bife: $12.800/kg
Lomo: $18.000/kg
Cuadril (con tapa): $10.800/kg
Tapa de cuadril (picanha): $11.500/kg
Colita de cuadril / Palomita: $10.200/kg
Corazón de cuadril: $11.000/kg
Nalga de adentro: $9.800/kg
Nalga de afuera (con peceto): $9.500/kg
Peceto: $9.000/kg
Bola de lomo: $9.300/kg
Carnaza cuadrada: $7.800/kg
Carnaza de paleta: $7.500/kg
Matambre: $8.200/kg
Pecho: $6.500/kg
Garrón / Osobuco: $7.200/kg
Tortuguita: $8.800/kg
Entraña fina: $14.500/kg
Entraña gruesa: $13.000/kg
Bife de vacío: $9.200/kg
Aguja: $7.300/kg
Marucha: $7.600/kg
Falda: $6.800/kg
Tapa de bife ancho: $9.500/kg
Chingolo de paleta: $7.400/kg
Cogote: $5.500/kg

=== CARNES PORCINAS ===
Bondiola: $8.900/kg
Costeletas de cerdo: $9.500/kg
Lomo de cerdo: $10.200/kg
Paleta de cerdo: $7.800/kg
Panceta: $7.500/kg
Jamón sin hueso: $9.800/kg
Pechito / Spare ribs: $8.200/kg

=== CARNES OVINAS ===
Paleta de cordero: $12.500/kg
Pierna de cordero: $13.800/kg
Costillar de cordero (rack): $14.500/kg
Lomo de cordero: $16.000/kg
Garrón ovino: $9.500/kg

=== ACHURAS Y MENUDENCIAS ===
Chinchulines: $5.200/kg
Mondongo: $4.800/kg
Mollejas: $9.500/kg
Riñones: $4.500/kg
Hígado: $4.200/kg
Corazón: $5.000/kg
Lengua: $7.800/kg
Rabo: $6.500/kg
Caracú: $3.500/kg
Morcilla: $1.200/u
Chorizo parrillero: $1.500/u

=== EMBUTIDOS ===
Chorizo seco: $2.800/u
Salchicha parrillera: $1.000/u
Salame: $3.200/100g
`;

// ============================================================
// FUNCIÓN: procesar mensaje del dueño con IA para extraer restricciones
// ============================================================
async function procesarContextoDueño(mensaje) {
    try {
        const res = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                {
                    role: "system",
                    content: `Sos un analizador de instrucciones de un vendedor de carnes.
Lee el mensaje del vendedor y extrae TODAS las restricciones, limitaciones o instrucciones especiales para hoy.
Responde en formato texto claro y conciso. Por ejemplo:
- Si dice "hoy no se hacen pedidos a domicilios", responde: "RESTRICCIÓN: Solo retiro en local, NO envío a domicilio"
- Si dice "no hay Lomo", responde: "PRODUCTOS NO DISPONIBLES: Lomo"
- Si dice algo especial, resúmelo claramente

Si el mensaje es solo un comando técnico (!stock, !abierto, !cerrado) o no contiene restricciones, responde: "SIN RESTRICCIONES"`
                },
                {
                    role: "user",
                    content: `Mensaje del vendedor: "${mensaje}"`
                }
            ]
        });

        const resultado = res.choices[0].message.content.trim();
        if (!resultado.includes("SIN RESTRICCIONES")) {
            return resultado;
        }
        return "";
    } catch (err) {
        console.error('❌ Error procesando contexto del dueño:', err.message);
        return "";
    }
}

// ============================================================
// FUNCIÓN: parsear el pedido confirmado desde el historial
// usando IA para extraer los datos estructurados
// ============================================================
async function extraerDatosPedido(historial, numeroCliente) {
    try {
        const res = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: [
                {
                    role: "system",
                    content: `Analizá la conversación de WhatsApp y extraé los datos del pedido confirmado.
Respondé ÚNICAMENTE con un JSON válido con esta estructura exacta, sin texto adicional:
{
  "items": [
    { "producto": "nombre del corte", "cantidad": "número con unidad (ej: 2 kg, 3 unidades)", "subtotal": número_en_pesos_sin_puntos }
  ],
  "total": número_en_pesos_sin_puntos,
  "entrega": "domicilio" o "retiro en local",
  "direccion": "dirección completa o 'Retira en local' si no hay envío",
  "horario_pedido": "hora en formato HH:MM"
}
Si algún dato no está claro, usá "No especificado".
Los precios de referencia son: ${LISTA_DE_PRECIOS}`
                },
                {
                    role: "user",
                    content: `Conversación:\n${historial.map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`).join('\n')}`
                }
            ]
        });

        const raw = res.choices[0].message.content.trim();
        // Limpiar posibles backticks de markdown
        const clean = raw.replace(/```json|```/g, '').trim();
        const datos = JSON.parse(clean);
        datos.numero = numeroCliente.replace('@s.whatsapp.net', '').replace(/^549/, '+549 ');
        datos.horario_pedido = datos.horario_pedido || new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
        return datos;
    } catch (err) {
        console.error('❌ Error al extraer datos del pedido:', err.message);
        return null;
    }
}

// ============================================================
// FUNCIÓN: formatear el resumen diario para el dueño
// ============================================================
function formatearResumenDiario(pedidos) {
    const fecha = new Date().toLocaleDateString('es-AR', { 
        weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
        timeZone: 'America/Argentina/Buenos_Aires'
    });

    if (pedidos.length === 0) {
        return `📋 *RESUMEN DIARIO — SUPREMO CORTE*\n📅 ${fecha}\n\nNo se registraron pedidos confirmados el día de hoy.`;
    }

    let totalGeneral = 0;
    let texto = `📋 *RESUMEN DIARIO — SUPREMO CORTE*\n📅 ${fecha}\n${'─'.repeat(30)}\n\n`;

    pedidos.forEach((p, i) => {
        texto += `🛒 *PEDIDO #${i + 1}*\n`;
        texto += `📱 WhatsApp: ${p.numero}\n`;
        texto += `🕐 Horario: ${p.horario_pedido}\n`;
        texto += `📦 Entrega: ${p.entrega}\n`;
        texto += `📍 Dirección: ${p.direccion}\n`;
        texto += `\n*Detalle:*\n`;

        if (p.items && p.items.length > 0) {
            p.items.forEach(item => {
                texto += `  • ${item.producto} — ${item.cantidad} → $${Number(item.subtotal).toLocaleString('es-AR')}\n`;
            });
        } else {
            texto += `  (Sin detalle disponible)\n`;
        }

        texto += `💰 *Total: $${Number(p.total).toLocaleString('es-AR')}*\n`;
        texto += `${'─'.repeat(30)}\n\n`;
        totalGeneral += Number(p.total) || 0;
    });

    texto += `✅ *Total de pedidos: ${pedidos.length}*\n`;
    texto += `💵 *Recaudación del día: $${totalGeneral.toLocaleString('es-AR')}*`;

    return texto;
}

// ============================================================
// SCHEDULER: envía resumen todos los días a las 18:00 (ARG)
// ============================================================
function iniciarScheduler() {
    const HORA_ENVIO = 18;

    function calcularMsHasta18() {
        const ahora = new Date();
        const argentina = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' }));
        
        const proximas18 = new Date(argentina);
        proximas18.setHours(HORA_ENVIO, 0, 0, 0);

        if (argentina.getHours() >= HORA_ENVIO) {
            proximas18.setDate(proximas18.getDate() + 1);
        }

        return proximas18.getTime() - argentina.getTime();
    }

    async function enviarResumenYReprogramar() {
        console.log('📨 Enviando resumen diario al dueño...');

        try {
            const resumen = formatearResumenDiario(pedidosDelDia);
            await sock.sendMessage(NUMERO_DUENO, { text: resumen });
            console.log(`✅ Resumen enviado. Pedidos del día: ${pedidosDelDia.length}`);
        } catch (err) {
            console.error('❌ Error al enviar resumen:', err.message);
        }

        // Limpiar pedidos del día después de enviar
        pedidosDelDia = [];

        // Reprogramar para el día siguiente a las 18hs
        const msHastaManana = calcularMsHasta18();
        console.log(`⏰ Próximo resumen en ${Math.round(msHastaManana / 1000 / 60)} minutos`);
        setTimeout(enviarResumenYReprogramar, msHastaManana);
    }

    const msPrimeraEjecucion = calcularMsHasta18();
    console.log(`⏰ Scheduler activo. Primer resumen en ${Math.round(msPrimeraEjecucion / 1000 / 60)} minutos`);
    setTimeout(enviarResumenYReprogramar, msPrimeraEjecucion);
}

// ============================================================
// WHATSAPP
// ============================================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
        },
        logger: pino({ level: 'silent' }),
        browser: ["Supremo Corte", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 0,
        keepAliveIntervalMs: 10000
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) { 
            lastQR = qr; 
            qrcode.generate(qr, { small: true }); 
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`⚠️ Conexión cerrada (Código: ${statusCode}). Reconectando: ${shouldReconnect}`);
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                console.log('❌ Sesión cerrada permanentemente.');
                lastQR = "";
            }
        } else if (connection === 'open') {
            lastQR = "CONECTADO";
            console.log('✅ ¡SUPREMO CORTE ONLINE!');
            // Iniciar scheduler SOLO cuando WhatsApp está conectado
            iniciarScheduler();
        }
    });

    // Detectar cuando se eliminan mensajes del grupo de configuración
    sock.ev.on('messages.delete', (jids) => {
        if (!jids) return;

        jids.forEach((jid) => {
            if (jid.remoteJid && jid.remoteJid.endsWith('@g.us')) {
                const messageId = jid.id;
                const config = mensajesConfiguracion.get(messageId);

                if (config) {
                    console.log(`🗑️ Mensaje eliminado del grupo: ${config.contenido}`);
                    mensajesConfiguracion.delete(messageId);

                    // Reconstruir el contexto desde los mensajes restantes
                    contextoDueño = "";
                    stockDisponible = {};

                    mensajesConfiguracion.forEach((cfg) => {
                        if (cfg.tipo === 'restriccion') {
                            contextoDueño = cfg.contexto; // El último es lo que cuenta
                        } else if (cfg.tipo === 'stock') {
                            const items = cfg.contenido.split(',');
                            items.forEach(item => {
                                const [producto, cantidad] = item.split(':');
                                if (producto && cantidad) {
                                    stockDisponible[producto.trim()] = cantidad.trim();
                                }
                            });
                        }
                    });

                    console.log(`📝 Contexto actualizado tras eliminación`);
                }
            }
        });
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];

        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const text = msg.message.conversation ||
                     msg.message.extendedTextMessage?.text ||
                     msg.message.imageMessage?.caption || "";

        if (!text) return;

        const lowText = text.toLowerCase().trim();

        // Procesar mensajes de GRUPO DE CONFIGURACIÓN
        if (from.endsWith('@g.us')) {
            // Intentar detectar el grupo "configuracion"
            const groupMetadata = await sock.groupMetadata(from).catch(() => null);
            if (groupMetadata && groupMetadata.subject.toLowerCase().includes('configuracion')) {
                grupoConfigId = from;
                console.log(`📋 Leyendo configuración del grupo: ${groupMetadata.subject}`);

                // Procesar mensaje del grupo para extraer restricciones o stock
                if (!msg.key.fromMe) {
                    const messageId = msg.key.id;

                    // Permitir comandos administrativos desde el grupo
                    if (lowText === '!cerrado') {
                        estadoAtencion = "cerrado";
                        mensajeEstadoCerrado = "Hoy no estamos tomando pedidos.";
                        await sock.sendMessage(from, { text: `🔴 Atención CERRADA por orden del grupo.` });
                        return;
                    }

                    if (lowText === '!abierto') {
                        estadoAtencion = "abierto";
                        mensajeEstadoCerrado = "";
                        contextoDueño = "";
                        await sock.sendMessage(from, { text: `✅ Atención ABIERTA. Se aceptan pedidos.` });
                        return;
                    }

                    if (lowText === '!resumen') {
                        const resumen = formatearResumenDiario(pedidosDelDia);
                        await sock.sendMessage(from, { text: resumen });
                        return;
                    }

                    if (lowText === '!stock') {
                        const stockText = Object.entries(stockDisponible).length > 0
                            ? Object.entries(stockDisponible).map(([k, v]) => `${k}: ${v}`).join('\n')
                            : 'Sin stock registrado';
                        await sock.sendMessage(from, { text: `📦 Stock Actual:\n${stockText}` });
                        return;
                    }

                    // Detectar si es un comando de stock (formato: "Asado: 50kg, Lomo: 30kg")
                    if (text.includes(':') && text.includes('kg')) {
                        try {
                            const items = text.split(',');
                            const stockParsed = [];
                            items.forEach(item => {
                                const [producto, cantidad] = item.split(':');
                                if (producto && cantidad) {
                                    stockDisponible[producto.trim()] = cantidad.trim();
                                    stockParsed.push(`${producto.trim()}: ${cantidad.trim()}`);
                                }
                            });
                            mensajesConfiguracion.set(messageId, {
                                tipo: 'stock',
                                contenido: text,
                                contexto: `STOCK: ${text}`
                            });
                            console.log(`📦 Stock actualizado desde grupo: ${text}`);

                            // Responder en el grupo confirmando lo entendido
                            const respuestaStock = `✅ Stock actualizado:\n${stockParsed.join('\n')}`;
                            await sock.sendMessage(from, { text: respuestaStock });
                        } catch (err) {
                            console.error('Error procesando stock:', err.message);
                            await sock.sendMessage(from, { text: '❌ Error procesando stock' });
                        }
                    } else {
                        // Procesar como restricción
                        const nuevoContexto = await procesarContextoDueño(text);
                        if (nuevoContexto) {
                            contextoDueño = nuevoContexto;
                            mensajesConfiguracion.set(messageId, {
                                tipo: 'restriccion',
                                contenido: text,
                                contexto: nuevoContexto
                            });
                            console.log(`📝 Contexto actualizado desde grupo: ${nuevoContexto}`);

                            // Responder en el grupo confirmando la restricción entendida
                            const respuestaRestriccion = `✅ Restricción activa:\n${nuevoContexto}`;
                            await sock.sendMessage(from, { text: respuestaRestriccion });
                        }
                    }
                }
            }
            return;
        }

        // Procesar comandos del dueño (incluso si fromMe es true)
        if (from === NUMERO_DUENO) {
            // Cambiar estado a CERRADO
            if (lowText.includes('no tomamos pedidos') || lowText === '!cerrado') {
                estadoAtencion = "cerrado";
                mensajeEstadoCerrado = text.includes('!cerrado') ? "Hoy no estamos tomando pedidos." : text;
                await sock.sendMessage(from, { text: `🔴 Atención CERRADA. Los clientes recibirán: "${mensajeEstadoCerrado}"` });
                return;
            }

            // Cambiar estado a ABIERTO
            if (lowText === '!abierto') {
                estadoAtencion = "abierto";
                mensajeEstadoCerrado = "";
                contextoDueño = ""; // Limpiar restricciones al abrir
                await sock.sendMessage(from, { text: `✅ Atención ABIERTA. Se aceptan pedidos nuevamente.` });
                return;
            }

            // Procesar cualquier otro mensaje del dueño para extraer restricciones
            if (!lowText.startsWith('!') &&
                lowText !== '!resumen' &&
                lowText !== '!stock' &&
                lowText !== '!abierto' &&
                lowText !== '!cerrado') {
                const nuevoContexto = await procesarContextoDueño(text);
                if (nuevoContexto) {
                    contextoDueño = nuevoContexto; // Reemplazar (no acumular) - el último mensaje es lo que cuenta
                    console.log(`📝 Contexto actualizado: ${nuevoContexto}`);
                }
            }
        }

        // Ignorar mensajes propios (excepto los del dueño que ya procesamos)
        if (msg.key.fromMe) return;

        if (lowText === '!ping') {
            await sock.sendMessage(from, { text: '✅ Carnicería SUPREMO CORTE online.' });
            return;
        }

        // Comando admin: forzar envío del resumen (para testing)
        if (from === NUMERO_DUENO && lowText === '!resumen') {
            const resumen = formatearResumenDiario(pedidosDelDia);
            await sock.sendMessage(from, { text: resumen });
            return;
        }

        // Comando admin: actualizar stock disponible
        if (from === NUMERO_DUENO && lowText.startsWith('!stock ')) {
            const stockData = text.substring(7).trim();
            try {
                // Parsear formato: "Asado de tira: 50kg, Lomo: 30kg"
                const items = stockData.split(',');
                items.forEach(item => {
                    const [producto, cantidad] = item.split(':');
                    if (producto && cantidad) {
                        stockDisponible[producto.trim()] = cantidad.trim();
                    }
                });
                await sock.sendMessage(from, { text: `✅ Stock actualizado:\n${JSON.stringify(stockDisponible, null, 2)}` });
                return;
            } catch (err) {
                await sock.sendMessage(from, { text: '❌ Error al procesar stock. Formato: !stock Asado: 50kg, Lomo: 30kg' });
                return;
            }
        }

        // Comando admin: ver stock actual
        if (from === NUMERO_DUENO && lowText === '!stock') {
            const stockText = Object.entries(stockDisponible).length > 0
                ? Object.entries(stockDisponible).map(([k, v]) => `${k}: ${v}`).join('\n')
                : 'Sin stock registrado';
            await sock.sendMessage(from, { text: `📦 Stock Actual:\n${stockText}` });
            return;
        }

        // Verificar si estamos atendiendo
        if (estadoAtencion === "cerrado") {
            const mensajeCierre = mensajeEstadoCerrado || "Disculpe, hoy no estamos tomando pedidos. Volveremos a atender próximamente.\n\n*— Carnicería SUPREMO CORTE*";
            await sock.sendMessage(from, { text: mensajeCierre });
            return;
        }

        // Inicializar historial del cliente
        if (!conversaciones.has(from)) {
            conversaciones.set(from, []);
        }
        const historial = conversaciones.get(from);
        historial.push({ role: "user", content: text });

        // Mantener historial acotado
        if (historial.length > 24) historial.splice(0, 2);

        try {
            console.log(`🥩 Cliente: ${from} | Mensaje: "${text}"`);
            await sock.sendPresenceUpdate('composing', from);

            const response = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages: [
                    { 
                        role: "system", 
                        content: `Sos el asistente virtual de SUPREMO CORTE, una carnicería de primer nivel.
Atendé con TOTAL FORMALIDAD. Usá "usted" siempre. Sé cálido pero correcto y profesional.

== FLUJO DE ATENCIÓN ==
1. Saludar y preguntar en qué puede ayudar.
2. Informar precios consultados.
3. Armar el pedido: preguntar corte, cantidad en kg o unidades.
4. Preguntar si desea ENVÍO A DOMICILIO o RETIRO EN LOCAL.
   - Si elige envío: pedirle la dirección completa (calle, número, localidad).
   - Si elige retiro: no pedir dirección.
5. Mostrar el resumen completo del pedido con subtotales y TOTAL en pesos.
6. Preguntar explícitamente: "¿Confirma el pedido? Responda SÍ para finalizar."
7. Cuando el cliente responda SÍ (o confirme), responder:
   "✅ ¡Pedido confirmado! Muchas gracias. Lo estaremos preparando. Ante cualquier consulta no dude en comunicarse."
   Y en ese mismo mensaje incluir al final la etiqueta oculta: [PEDIDO_CONFIRMADO]

== LISTA DE PRECIOS ==
${LISTA_DE_PRECIOS}

== STOCK DISPONIBLE ==
${Object.entries(stockDisponible).length > 0
    ? Object.entries(stockDisponible).map(([k, v]) => `${k}: ${v}`).join('\n')
    : '(Consultá al dueño sobre disponibilidad)'}

== EQUIVALENCIAS ==
- Asado con hueso / costilla → Asado de tira
- Picaña / picanha → Tapa de cuadril
- Palomita → Colita de cuadril
- Ossobuco → Garrón
- Bife de chorizo → Bife angosto
- Ojo de bife → Bife ancho sin tapa
- Chinchulín → Chinchulines

== HORARIO ==
Lunes a viernes: 7:00–13:00 y 17:00–20:00. Sábados: 7:00–13:00.
Pedidos por WhatsApp hasta 1 hora antes del cierre.

${contextoDueño ? `== RESTRICCIONES/INSTRUCCIONES HOY ==
${contextoDueño}

` : ''}== REGLAS ==
- No inventés precios fuera de la lista.
- Confirmá siempre el pedido antes de cerrar.
- NO firmes con nada, solo responde naturalmente`
                    },
                    ...historial
                ]
            });

            const aiResponse = response.choices[0].message.content;
            historial.push({ role: "assistant", content: aiResponse });

            // Detectar si el bot acaba de confirmar un pedido
            if (aiResponse.includes('[PEDIDO_CONFIRMADO]')) {
                console.log(`📦 Pedido confirmado de ${from}. Extrayendo datos...`);
                
                // Extraer datos estructurados del pedido con IA
                const datosPedido = await extraerDatosPedido(historial, from);
                if (datosPedido) {
                    pedidosDelDia.push(datosPedido);
                    console.log(`✅ Pedido #${pedidosDelDia.length} registrado:`, datosPedido);
                }

                // Limpiar conversación de este cliente para futuros pedidos
                conversaciones.delete(from);

                // Enviar mensaje sin la etiqueta técnica + firma
                const mensajeLimpio = aiResponse.replace('[PEDIDO_CONFIRMADO]', '').trim();
                const mensajeConFirma = `${mensajeLimpio}\n\n*— Carnicería SUPREMO CORTE*`;
                await sock.sendMessage(from, { text: mensajeConFirma });
            } else {
                await sock.sendMessage(from, { text: aiResponse });
            }

        } catch (err) {
            console.error('❌ Error Groq:', err.message);
            await sock.sendMessage(from, {
                text: 'Disculpe, estamos experimentando inconvenientes técnicos. Por favor intente nuevamente en unos minutos.'
            });
        }
    });
}

connectToWhatsApp();

// ============================================================
// ENDPOINTS
// ============================================================
app.get('/qr', (req, res) => {
    if (lastQR === "CONECTADO") return res.send(`
        <div style="text-align:center;padding:50px;font-family:sans-serif;">
            <h1>✅ SUPREMO CORTE — Bot Activo</h1>
            <p>El asistente virtual está conectado y operativo.</p>
        </div>
    `);
    if (!lastQR) return res.send('<h1>Iniciando...</h1><p>Recargá en 10 segundos.</p>');
    res.send(`
        <div style="text-align:center;padding:50px;font-family:sans-serif;">
            <h2>🥩 Vincular Bot — SUPREMO CORTE</h2>
            <img src="https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(lastQR)}&size=300x300"/>
            <p>Escaneá desde WhatsApp → Dispositivos Vinculados</p>
        </div>
    `);
});

// Ver pedidos acumulados del día (para debug)
app.get('/pedidos', (req, res) => {
    res.json({ 
        cantidad: pedidosDelDia.length, 
        pedidos: pedidosDelDia 
    });
});

app.get('/', (req, res) => res.send('🥩 SUPREMO CORTE — Asistente Virtual Activo'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🥩 SUPREMO CORTE corriendo en puerto ${PORT}`));
