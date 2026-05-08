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

// --- SISTEMA DE PEDIDOS EN MEMORIA ---
const pedidosEnCurso = new Map(); // Almacena el estado de pedido por número de cliente

// --- LISTA DE PRECIOS SUPREMO CORTE ---
const LISTA_DE_PRECIOS = `
=== CARNES BOVINAS ===
Asado de tira: $8.500/kg
Vacío: $9.200/kg
Bife ancho (con tapa): $12.500/kg
Bife angosto: $13.000/kg
Lomo: $18.000/kg
Cuadril (con tapa): $10.800/kg
Tapa de cuadril (picanha): $11.500/kg
Colita de cuadril: $10.200/kg
Corazón de cuadril: $11.000/kg
Nalga de adentro: $9.800/kg
Nalga de afuera (con peceto): $9.500/kg
Peceto: $9.000/kg
Bola de lomo: $9.300/kg
Carnaza cuadrada: $7.800/kg
Carnaza de paleta: $7.500/kg
Matambre: $8.200/kg
Pecho: $6.500/kg
Garrón (ossobuco): $7.200/kg
Tortuguita: $8.800/kg
Palomita (colita de cuadril): $10.200/kg
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
Jamón de cerdo (sin hueso): $9.800/kg
Pechito de cerdo (spare ribs): $8.200/kg
Bondiola entera: $8.700/kg

=== CARNES OVINAS ===
Paleta de cordero: $12.500/kg
Pierna de cordero: $13.800/kg
Costillar de cordero (rack): $14.500/kg
Lomo de cordero: $16.000/kg
Garrón ovino: $9.500/kg

=== ACHURAS Y MENUDENCIAS ===
Chinchulines (intestino delgado): $5.200/kg
Mondongo: $4.800/kg
Mollejas: $9.500/kg
Riñones: $4.500/kg
Hígado: $4.200/kg
Corazón: $5.000/kg
Lengua: $7.800/kg
Rabo: $6.500/kg
Caracú (hueso medular): $3.500/kg
Morcillas (unidad): $1.200/u
Chorizos: $1.500/u

=== EMBUTIDOS Y ELABORADOS ===
Chorizo parrillero: $1.500/u
Chorizo seco: $2.800/u
Morcilla: $1.200/u
Salchicha parrillera: $1.000/u
Salame: $3.200/100g
`;

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
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        if (from.endsWith('@g.us')) return;

        const text = msg.message.conversation || 
                     msg.message.extendedTextMessage?.text || 
                     msg.message.imageMessage?.caption || "";

        if (!text) {
            console.log('⚠️ Mensaje vacío o sin descifrar. Ignorando...');
            return;
        }

        const lowText = text.toLowerCase();

        // Comando de prueba
        if (lowText === '!ping') {
            await sock.sendMessage(from, { text: '✅ Carnicería SUPREMO CORTE online.' });
            return;
        }

        // Recuperar o inicializar el historial de conversación del cliente
        if (!pedidosEnCurso.has(from)) {
            pedidosEnCurso.set(from, []);
        }
        const historial = pedidosEnCurso.get(from);

        // Agregar mensaje del usuario al historial
        historial.push({ role: "user", content: text });

        // Limitar historial a últimos 10 mensajes para no exceder tokens
        if (historial.length > 20) {
            historial.splice(0, 2);
        }

        try {
            console.log(`🥩 Cliente: ${from} | Mensaje: "${text}"`);
            await sock.sendPresenceUpdate('composing', from);

            const response = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages: [
                    { 
                        role: "system", 
                        content: `Sos el asistente virtual de SUPREMO CORTE, una carnicería de primer nivel.

Tu rol es atender a los clientes con TOTAL FORMALIDAD y PROFESIONALISMO. Usá "usted" siempre, nunca tutees ni uses lunfardo. Sé cálido pero serio y correcto.

== TUS FUNCIONES ==
1. Saludar cordialmente y presentar la carnicería cuando el cliente se contacta por primera vez.
2. Informar precios de cualquier corte consultado.
3. Tomar pedidos de forma ordenada: preguntar qué corte, cantidad en kg o unidades, y si necesita algo más.
4. Confirmar el pedido completo al final con un resumen claro.
5. Informar que los pedidos pueden retirarse en el local o consultar por envío según la zona.
6. Si el cliente pregunta por un corte que no está en la lista, indicar amablemente que no está disponible o sugerir uno similar.

== LISTA DE PRECIOS ACTUALIZADA ==
${LISTA_DE_PRECIOS}

== EQUIVALENCIAS DE CORTES (por si el cliente usa nombres alternativos) ==
- Asado con hueso / costilla / tira de asado → Asado de tira
- Picaña / picanha → Tapa de cuadril
- Palomita → Colita de cuadril
- Ossobuco → Garrón
- Entraña → puede ser entraña fina o entraña gruesa, consultar
- Lomo fino → Lomo
- Bife de chorizo → Bife angosto
- Ojo de bife → Bife ancho sin tapa
- Chinchulín → Chinchulines
- Tira de asado → Asado de tira
- Punta de espalda → Aguja

== REGLAS DE ORO ==
- NUNCA inventés precios que no estén en la lista.
- Si el cliente pide un corte que no conocés, preguntale cómo también se llama o describilo.
- Siempre confirmá el pedido antes de cerrar la conversación.
- Usá formato claro para el resumen de pedidos (lista con cantidades y subtotales).
- Firmá cada respuesta con: *— Carnicería SUPREMO CORTE*

== HORARIO Y DATOS ==
Horario de atención: Lunes a viernes de 7:00 a 13:00 y de 17:00 a 20:00. Sábados de 7:00 a 13:00.
Los pedidos por WhatsApp se toman hasta 1 hora antes del cierre.`
                    },
                    ...historial
                ]
            });

            const aiResponse = response.choices[0].message.content;

            // Agregar respuesta del bot al historial
            historial.push({ role: "assistant", content: aiResponse });

            await sock.sendMessage(from, { text: aiResponse });

        } catch (err) {
            console.error('❌ Error Groq:', err.message);
            await sock.sendMessage(from, { 
                text: 'Disculpe, estamos experimentando inconvenientes técnicos. Por favor intente nuevamente en unos minutos.\n\n*— Carnicería SUPREMO CORTE*' 
            });
        }
    });
}

connectToWhatsApp();

app.get('/qr', (req, res) => {
    if (lastQR === "CONECTADO") return res.send(`
        <div style="text-align:center; padding:50px; font-family:sans-serif;">
            <h1>✅ SUPREMO CORTE — Bot Activo</h1>
            <p>El asistente virtual está conectado y operativo.</p>
        </div>
    `);
    if (!lastQR) return res.send('<h1>Iniciando...</h1><p>Recargá en 10 segundos.</p>');
    res.send(`
        <div style="text-align:center; padding:50px; font-family:sans-serif;">
            <h2>🥩 Vincular Bot — SUPREMO CORTE</h2>
            <img src="https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(lastQR)}&size=300x300" />
            <p>Escaneá desde WhatsApp > Dispositivos Vinculados</p>
        </div>
    `);
});

app.get('/', (req, res) => res.send('🥩 SUPREMO CORTE — Asistente Virtual Activo'));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🥩 SUPREMO CORTE corriendo en puerto ${PORT}`));
