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
const NUMERO_DUENO = "5491158660344@s.whatsapp.net"; // Rodrigo +5491158660344

// ============================================================
// GRUPO DE CONFIGURACIÓN — donde el dueño escribe restricciones
// ============================================================
const NOMBRE_GRUPO_CONFIG = "configuracion"; // Nombre EXACTO del grupo privado con Rodrigo, Romina y el bot
let grupoConfigId = null; // Se detecta automáticamente
let cachConfigGrupo = null; // Cachea metadatos del grupo para evitar lecturas en cada mensaje
let ultimaActualizacionConfigGrupo = 0; // Timestamp de la última actualización
const INTERVALO_REFRESH_CONFIG = 5 * 60 * 1000; // Actualizar cache cada 5 minutos

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
// LISTA DE PRECIOS - CATÁLOGO DE ROPA
// ============================================================
const LISTA_DE_PRECIOS = `
=== REMERAS ===
Remera básica (Nueva): $1.500
Remera deportiva (Nueva con etiqueta): $2.500
Remera estampada (Nueva): $2.000
Remera como nueva: $800
Remera usada (buen estado): $500

=== BUZOS Y CAMPERAS ===
Buzo básico (Nueva con etiqueta): $3.500
Buzo deportivo (Nueva): $4.000
Campera de jean (Nueva): $5.500
Campera de jean (Usada como nueva): $2.500
Buzo usada (buen estado): $1.500

=== PANTALONES ===
Pantalón de jean (Nueva con etiqueta): $4.000
Pantalón de tela (Nueva): $3.500
Pantalón deportivo (Nueva): $3.000
Pantalón de jean (Como nueva): $1.800
Pantalón usada (buen estado): $1.000

=== FALDAS Y VESTIDOS ===
Falda de tela (Nueva con etiqueta): $3.000
Vestido casual (Nueva): $4.500
Vestido de fiesta (Nueva): $6.000
Falda usada (buen estado): $1.200
Vestido usado (como nueva): $2.500

=== PRENDAS ÍNTIMAS ===
Pack de medias (Nueva): $800
Ropa interior pack x3 (Nueva): $1.500
Corpiño (Nueva con etiqueta): $2.500
Medias usadas (buen estado): $300

=== ACCESORIOS ===
Cinturones (Nueva): $1.200
Gorras (Nueva): $1.500
Bufandas (Nueva): $1.000
Sombreros (Nueva): $2.000
Mochilas (Nueva): $3.500

=== PRENDAS ESPECIALES ===
Abrigo de invierno (Nueva con etiqueta): $8.000
Abrigo de invierno (Usada como nueva): $3.500
Piloto (Nueva): $6.500
Sudadera premium (Nueva): $5.000
Conjunto deportivo (Nueva): $4.500
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
                    content: `Sos un analizador de instrucciones de un vendedor de ropa.
Lee el mensaje del vendedor y extrae TODAS las restricciones, limitaciones o instrucciones especiales para hoy.
Responde en formato texto claro y conciso. Por ejemplo:
- Si dice "hoy no se hacen pedidos a domicilios", responde: "RESTRICCIÓN: Solo retiro en local, NO envío a domicilio"
- Si dice "no hay Remeras", responde: "PRODUCTOS NO DISPONIBLES: Remeras"
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
    { "producto": "nombre de la prenda", "cantidad": "número con unidad (ej: 2 remeras, 3 pantalones)", "subtotal": número_en_pesos_sin_puntos }
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
        return `📋 *RESUMEN DIARIO — SHOWROOM DEREK*\n📅 ${fecha}\n\nNo se registraron pedidos confirmados el día de hoy.`;
    }

    let totalGeneral = 0;
    let texto = `📋 *RESUMEN DIARIO — SHOWROOM DEREK*\n📅 ${fecha}\n${'─'.repeat(30)}\n\n`;

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
// CARGAR Y CACHEAR CONFIGURACIÓN DEL GRUPO
// ============================================================
async function cargarYCachearConfigGrupo() {
    try {
        if (!sock || !sock.groupFetchAllParticipating) return;

        const grupos = await sock.groupFetchAllParticipating().catch(() => ({}));

        for (const [jid, grupo] of Object.entries(grupos)) {
            if (grupo.subject && grupo.subject.toLowerCase().includes(NOMBRE_GRUPO_CONFIG.toLowerCase())) {
                cachConfigGrupo = {
                    id: jid,
                    subject: grupo.subject,
                    participants: grupo.participants
                };
                grupoConfigId = jid;
                ultimaActualizacionConfigGrupo = Date.now();
                console.log(`✅ Grupo de configuración cacheado: "${grupo.subject}" (${jid})`);
                return;
            }
        }

        console.warn(`⚠️ No se encontró grupo que contenga "${NOMBRE_GRUPO_CONFIG}". Intentaremos detectarlo en el próximo mensaje.`);
    } catch (error) {
        console.error('❌ Error al cachear grupo de configuración:', error.message);
    }
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
        browser: ["Showroom Derek", "Chrome", "1.0.0"],
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
            console.log('✅ ¡SHOWROOM DEREK ONLINE!');
            // Cargar configuración del grupo
            cargarYCachearConfigGrupo();
            // Actualizar cache cada 5 minutos
            setInterval(cargarYCachearConfigGrupo, INTERVALO_REFRESH_CONFIG);
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
            // Usar configuración cacheada, o intentar detectarla si no está en caché
            if (!cachConfigGrupo || from !== cachConfigGrupo.id) {
                const groupMetadata = await sock.groupMetadata(from).catch(() => null);
                if (groupMetadata && groupMetadata.subject.toLowerCase().includes(NOMBRE_GRUPO_CONFIG.toLowerCase())) {
                    cachConfigGrupo = {
                        id: from,
                        subject: groupMetadata.subject,
                        participants: groupMetadata.participants
                    };
                    grupoConfigId = from;
                    ultimaActualizacionConfigGrupo = Date.now();
                    console.log(`✅ Grupo de configuración detectado: "${groupMetadata.subject}" (${from})`);
                } else {
                    return; // No es el grupo de configuración
                }
            }

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

                    // Detectar si es un comando de stock (formato: "Remeras: 50, Pantalones: 30")
                    if (text.includes(':') && (text.includes('u') || /\d/.test(text))) {
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
            await sock.sendMessage(from, { text: '✅ Carnicería SHOWROOM DEREK online.' });
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
                // Parsear formato: "Remeras: 50, Pantalones: 30"
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
                await sock.sendMessage(from, { text: '❌ Error al procesar stock. Formato: !stock Remeras: 50, Pantalones: 30' });
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
            const mensajeCierre = mensajeEstadoCerrado || "Disculpe, hoy no estamos tomando pedidos. Volveremos a atender próximamente.\n\n*— Carnicería SHOWROOM DEREK*";
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
                        content: `Sos el asistente virtual de SHOWROOM DEREK, una carnicería de primer nivel.
Atendé con TOTAL FORMALIDAD. Usá "usted" siempre. Sé cálido pero correcto y profesional.

== FLUJO DE ATENCIÓN ==
1. Saludar y preguntar en qué puede ayudar.
2. Informar precios consultados.
3. Armar el pedido: preguntar prenda, cantidad y talle (si aplica).
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
                const mensajeConFirma = `${mensajeLimpio}\n\n*— Carnicería SHOWROOM DEREK*`;
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
            <h1>✅ SHOWROOM DEREK — Bot Activo</h1>
            <p>El asistente virtual está conectado y operativo.</p>
        </div>
    `);
    if (!lastQR) return res.send('<h1>Iniciando...</h1><p>Recargá en 10 segundos.</p>');
    res.send(`
        <div style="text-align:center;padding:50px;font-family:sans-serif;">
            <h2>🥩 Vincular Bot — SHOWROOM DEREK</h2>
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

app.get('/', (req, res) => res.send('🥩 SHOWROOM DEREK — Asistente Virtual Activo'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🥩 SHOWROOM DEREK corriendo en puerto ${PORT}`));
