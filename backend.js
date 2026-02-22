// ==============================
// backend.js - API REST + Bot de Telegram (UNIFICADO)
// Versión completa - CON TODOS LOS ENDPOINTS DE ADMIN
// Incluye manejo robusto de errores para la columna bonus_cup
// ==============================

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const axios = require('axios');
const cors = require('cors');
const moment = require('moment-timezone');

// ========== IMPORTAR BOT DE TELEGRAM ==========
const bot = require('./bot');

// ========== CONFIGURACIÓN DESDE .ENV ==========
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BONUS_CUP_DEFAULT = parseFloat(process.env.BONUS_CUP_DEFAULT) || 70;
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const TIMEZONE = process.env.TIMEZONE || 'America/Havana';

// ========== INICIALIZAR SUPABASE ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ========== INICIALIZAR EXPRESS ==========
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'webapp')));

// ========== CONFIGURACIÓN DE MULTER ==========
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB
});

// ========== MAPA DE REGIONES CON EMOJIS ==========
const regionMap = {
    'Florida': { key: 'florida', emoji: '🦩' },
    'Georgia': { key: 'georgia', emoji: '🍑' },
    'Nueva York': { key: 'newyork', emoji: '🗽' }
};

// ========== FUNCIONES AUXILIARES ==========

function isAdmin(userId) {
    return ADMIN_IDS.includes(parseInt(userId));
}

function verifyTelegramWebAppData(initData, botToken) {
    const encoded = decodeURIComponent(initData);
    const arr = encoded.split('&');
    const hashIndex = arr.findIndex(e => e.startsWith('hash='));
    const hash = arr.splice(hashIndex)[0].split('=')[1];
    arr.sort((a, b) => a.localeCompare(b));
    const dataCheckString = arr.join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    return computedHash === hash;
}

// Obtener todas las tasas
async function getExchangeRates() {
    const { data } = await supabase
        .from('exchange_rate')
        .select('rate, rate_usdt, rate_trx')
        .eq('id', 1)
        .single();
    return data || { rate: 110, rate_usdt: 110, rate_trx: 1 };
}

async function getExchangeRateUSD() {
    const rates = await getExchangeRates();
    return rates.rate;
}

async function getExchangeRateUSDT() {
    const rates = await getExchangeRates();
    return rates.rate_usdt;
}

async function getExchangeRateTRX() {
    const rates = await getExchangeRates();
    return rates.rate_trx;
}

async function setExchangeRateUSD(rate) {
    await supabase
        .from('exchange_rate')
        .update({ rate, updated_at: new Date() })
        .eq('id', 1);
}

async function setExchangeRateUSDT(rate) {
    await supabase
        .from('exchange_rate')
        .update({ rate_usdt: rate, updated_at: new Date() })
        .eq('id', 1);
}

async function setExchangeRateTRX(rate) {
    await supabase
        .from('exchange_rate')
        .update({ rate_trx: rate, updated_at: new Date() })
        .eq('id', 1);
}

// Convertir cualquier moneda a CUP
async function convertToCUP(amount, currency) {
    const rates = await getExchangeRates();
    switch (currency) {
        case 'CUP': return amount;
        case 'USD': return amount * rates.rate;
        case 'USDT': return amount * rates.rate_usdt;
        case 'TRX': return amount * rates.rate_trx;
        case 'MLC': return amount * rates.rate; // MLC se trata como USD
        default: return 0;
    }
}

// Convertir de CUP a otra moneda
async function convertFromCUP(amountCUP, targetCurrency) {
    const rates = await getExchangeRates();
    switch (targetCurrency) {
        case 'CUP': return amountCUP;
        case 'USD': return amountCUP / rates.rate;
        case 'USDT': return amountCUP / rates.rate_usdt;
        case 'TRX': return amountCUP / rates.rate_trx;
        case 'MLC': return amountCUP / rates.rate;
        default: return 0;
    }
}

// ========== FUNCIÓN GETORCREATEUSER CON MANEJO DE ERROR DE COLUMNA ==========
async function getOrCreateUser(telegramId, firstName = 'Jugador', username = null) {
    try {
        let { data: user, error: selectError } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (selectError) {
            console.error('Error al consultar usuario:', selectError);
            // Devolvemos un objeto por defecto para no romper la app
            return {
                telegram_id: telegramId,
                first_name: firstName,
                username: username,
                bonus_cup: BONUS_CUP_DEFAULT,
                cup: 0,
                usd: 0
            };
        }

        if (!user) {
            try {
                const { data: newUser, error: insertError } = await supabase
                    .from('users')
                    .insert({
                        telegram_id: telegramId,
                        first_name: firstName,
                        username: username,
                        bonus_cup: BONUS_CUP_DEFAULT,
                        cup: 0,
                        usd: 0
                    })
                    .select()
                    .single();

                if (insertError) {
                    console.error('Error al crear usuario:', insertError);
                    // Si hay error (ej. columna bonus_cup no existe), devolvemos objeto por defecto
                    return {
                        telegram_id: telegramId,
                        first_name: firstName,
                        username: username,
                        bonus_cup: BONUS_CUP_DEFAULT,
                        cup: 0,
                        usd: 0
                    };
                }
                user = newUser;
                // El mensaje de bienvenida se envía solo en el bot, no aquí
            } catch (insertException) {
                console.error('Excepción al crear usuario:', insertException);
                return {
                    telegram_id: telegramId,
                    first_name: firstName,
                    username: username,
                    bonus_cup: BONUS_CUP_DEFAULT,
                    cup: 0,
                    usd: 0
                };
            }
        } else {
            if (username && user.username !== username) {
                await supabase
                    .from('users')
                    .update({ username })
                    .eq('telegram_id', telegramId)
                    .catch(e => console.error('Error actualizando username:', e));
            }
        }
        return user;
    } catch (e) {
        console.error('Error grave en getOrCreateUser:', e);
        return {
            telegram_id: telegramId,
            first_name: firstName,
            username: username,
            bonus_cup: BONUS_CUP_DEFAULT,
            cup: 0,
            usd: 0
        };
    }
}

async function getMinDepositUSD() {
    const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'min_deposit_usd')
        .single();
    return data ? parseFloat(data.value) : 1.0;
}

async function getMinWithdrawUSD() {
    const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'min_withdraw_usd')
        .single();
    return data ? parseFloat(data.value) : 1.0;
}

async function setMinDepositUSD(value) {
    await supabase
        .from('app_config')
        .upsert({ key: 'min_deposit_usd', value: value.toString() }, { onConflict: 'key' });
}

async function setMinWithdrawUSD(value) {
    await supabase
        .from('app_config')
        .upsert({ key: 'min_withdraw_usd', value: value.toString() }, { onConflict: 'key' });
}

// Parsear monto con moneda (ej: "500 cup", "10 usdt")
function parseAmountWithCurrency(text) {
    const lower = text.toLowerCase().replace(',', '.').trim();
    const match = lower.match(/^(\d+(?:\.\d+)?)\s*(cup|usd|usdt|trx|mlc)$/);
    if (!match) return null;
    return {
        amount: parseFloat(match[1]),
        currency: match[2].toUpperCase()
    };
}

// ========== FUNCIONES DE PARSEO DE APUESTAS ==========
function parseBetLine(line, betType) {
    line = line.trim().toLowerCase();
    if (!line) return [];

    const match = line.match(/^([\d\s,]+)\s*(?:con|\*)\s*([0-9.]+)\s*(cup|usd)?$/i);
    if (!match) return [];

    let numerosStr = match[1].trim();
    const montoStr = match[2];
    const moneda = (match[3] || 'usd').toUpperCase();

    const numeros = numerosStr.split(/[\s,]+/).filter(n => n.length > 0);
    const montoBase = parseFloat(montoStr);
    if (isNaN(montoBase) || montoBase <= 0) return [];

    const resultados = [];

    for (let numero of numeros) {
        let montoReal = montoBase;
        let numeroGuardado = numero;

        if (betType === 'fijo') {
            if (/^\d{2}$/.test(numero)) {
                // normal
            } else if (/^[Dd](\d)$/.test(numero)) {
                montoReal = montoBase * 10;
                numeroGuardado = numero.toUpperCase();
            } else if (/^[Tt](\d)$/.test(numero)) {
                montoReal = montoBase * 10;
                numeroGuardado = numero.toUpperCase();
            } else {
                continue;
            }
        } else if (betType === 'corridos') {
            if (!/^\d{2}$/.test(numero)) continue;
        } else if (betType === 'centena') {
            if (!/^\d{3}$/.test(numero)) continue;
        } else if (betType === 'parle') {
            if (!/^\d{2}x\d{2}$/.test(numero)) continue;
        } else {
            continue;
        }

        resultados.push({
            numero: numeroGuardado,
            currency: moneda,
            amount: montoReal
        });
    }

    return resultados;
}

function parseBetMessage(text, betType) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const items = [];
    let totalCUP = 0, totalUSD = 0;

    for (const line of lines) {
        const parsedItems = parseBetLine(line, betType);
        for (const item of parsedItems) {
            items.push(item);
            if (item.currency === 'CUP') totalCUP += item.amount;
            else if (item.currency === 'USD') totalUSD += item.amount;
        }
    }

    return {
        items,
        totalCUP,
        totalUSD,
        ok: items.length > 0
    };
}

function getEndTimeFromSlot(lottery, timeSlot) {
    const region = regionMap[lottery];
    if (!region) return null;
    const schedules = {
        florida: {
            slots: [
                { name: '🌅 Mañana', end: 13 },
                { name: '🌙 Noche', end: 21 }
            ]
        },
        georgia: {
            slots: [
                { name: '🌅 Mañana', end: 12 },
                { name: '☀️ Tarde', end: 18.5 },
                { name: '🌙 Noche', end: 23 }
            ]
        },
        newyork: {
            slots: [
                { name: '🌅 Mañana', end: 14 },
                { name: '🌙 Noche', end: 22 }
            ]
        }
    };
    const regionSched = schedules[region.key];
    if (!regionSched) return null;
    const slot = regionSched.slots.find(s => s.name === timeSlot);
    if (!slot) return null;
    const now = moment.tz(TIMEZONE);
    let hour = Math.floor(slot.end);
    let minute = (slot.end % 1) * 60;
    const endTime = now.clone().hour(hour).minute(minute).second(0).millisecond(0);
    if (now.isSameOrAfter(endTime)) {
        return null;
    }
    return endTime.toDate();
}

async function broadcastToAllUsers(message, parseMode = 'HTML') {
    const { data: users } = await supabase
        .from('users')
        .select('telegram_id');

    for (const u of users || []) {
        try {
            await bot.telegram.sendMessage(u.telegram_id, message, { parse_mode: parseMode });
            await new Promise(resolve => setTimeout(resolve, 30));
        } catch (e) {
            console.warn(`Error enviando broadcast a ${u.telegram_id}:`, e.message);
        }
    }
}

// ========== MIDDLEWARE DE ADMIN ==========
async function requireAdmin(req, res, next) {
    let userId = req.body.userId || req.query.userId || req.headers['x-telegram-id'];
    if (!userId) {
        return res.status(403).json({ error: 'No autorizado: falta userId' });
    }
    if (!isAdmin(userId)) {
        return res.status(403).json({ error: 'No autorizado: no eres admin' });
    }
    next();
}

// ========== ENDPOINTS PÚBLICOS ==========

// --- Autenticación ---
app.post('/api/auth', async (req, res) => {
    const { initData } = req.body;
    if (!initData) return res.status(400).json({ error: 'Falta initData' });

    const verified = verifyTelegramWebAppData(initData, BOT_TOKEN);
    if (!verified) return res.status(401).json({ error: 'Firma inválida' });

    const params = new URLSearchParams(decodeURIComponent(initData));
    const userStr = params.get('user');
    if (!userStr) return res.status(400).json({ error: 'No hay datos de usuario' });

    const tgUser = JSON.parse(userStr);
    const user = await getOrCreateUser(tgUser.id, tgUser.first_name, tgUser.username);
    const rates = await getExchangeRates();

    const botInfo = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)
        .then(r => r.data.result)
        .catch(() => ({ username: '4pu3$t4$_QvaBot' }));

    res.json({
        user,
        isAdmin: isAdmin(tgUser.id),
        exchangeRate: rates.rate,
        exchangeRateUSDT: rates.rate_usdt,
        exchangeRateTRX: rates.rate_trx,
        botUsername: botInfo.username,
        bonusCupDefault: BONUS_CUP_DEFAULT
    });
});

// --- Métodos de depósito ---
app.get('/api/deposit-methods', async (req, res) => {
    const { data } = await supabase.from('deposit_methods').select('*').order('id');
    res.json(data || []);
});
app.get('/api/deposit-methods/:id', async (req, res) => {
    const { data } = await supabase.from('deposit_methods').select('*').eq('id', req.params.id).single();
    res.json(data);
});

// --- Métodos de retiro ---
app.get('/api/withdraw-methods', async (req, res) => {
    const { data } = await supabase.from('withdraw_methods').select('*').order('id');
    res.json(data || []);
});
app.get('/api/withdraw-methods/:id', async (req, res) => {
    const { data } = await supabase.from('withdraw_methods').select('*').eq('id', req.params.id).single();
    res.json(data);
});

// --- Precios de jugadas ---
app.get('/api/play-prices', async (req, res) => {
    const { data } = await supabase.from('play_prices').select('*');
    res.json(data || []);
});

// --- Tasas de cambio ---
app.get('/api/exchange-rates', async (req, res) => {
    const rates = await getExchangeRates();
    res.json(rates);
});

// --- Mínimo depósito ---
app.get('/api/config/min-deposit', async (req, res) => {
    const value = await getMinDepositUSD();
    res.json({ value });
});

// --- Mínimo retiro ---
app.get('/api/config/min-withdraw', async (req, res) => {
    const value = await getMinWithdrawUSD();
    res.json({ value });
});

// --- Números ganadores ---
app.get('/api/winning-numbers', async (req, res) => {
    const { data } = await supabase
        .from('winning_numbers')
        .select('*')
        .order('published_at', { ascending: false })
        .limit(10);
    const formatted = (data || []).map(w => ({
        ...w,
        formatted_number: w.numbers[0].replace(/(\d{3})(\d{4})/, '$1 $2')
    }));
    res.json(formatted);
});

// --- Sesión activa ---
app.get('/api/lottery-sessions/active', async (req, res) => {
    const { lottery, date, time_slot } = req.query;
    if (!lottery || !date || !time_slot) {
        return res.status(400).json({ error: 'Faltan parámetros' });
    }
    const { data } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('lottery', lottery)
        .eq('date', date)
        .eq('time_slot', time_slot)
        .eq('status', 'open')
        .maybeSingle();
    res.json(data);
});

// --- Obtener sesión por ID ---
app.get('/api/lottery-sessions/:id', async (req, res) => {
    const { id } = req.params;
    const { data } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('id', id)
        .single();
    res.json(data);
});

// --- Solicitud de depósito ---
app.post('/api/deposit-requests', upload.single('screenshot'), async (req, res) => {
    const { methodId, userId, amount, currency } = req.body;
    const file = req.file;
    if (!methodId || !userId || !file || !amount || !currency) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    const user = await getOrCreateUser(parseInt(userId));
    const { data: method } = await supabase
        .from('deposit_methods')
        .select('*')
        .eq('id', methodId)
        .single();

    if (!method) {
        return res.status(400).json({ error: 'Método no encontrado' });
    }

    if (method.currency !== currency) {
        return res.status(400).json({ error: `La moneda del método es ${method.currency}, no coincide.` });
    }

    const parsed = parseAmountWithCurrency(amount);
    if (!parsed || parsed.currency !== currency) {
        return res.status(400).json({ error: 'Formato de monto inválido' });
    }

    if (method.min_amount !== null && parsed.amount < method.min_amount) {
        return res.status(400).json({ error: `Monto mínimo: ${method.min_amount} ${currency}` });
    }
    if (method.max_amount !== null && parsed.amount > method.max_amount) {
        return res.status(400).json({ error: `Monto máximo: ${method.max_amount} ${currency}` });
    }

    const fileName = `deposit_${userId}_${Date.now()}.jpg`;
    const filePath = `deposits/${fileName}`;

    const { error: uploadError } = await supabase.storage
        .from('deposit-screenshots')
        .upload(filePath, file.buffer, { contentType: 'image/jpeg' });

    if (uploadError) {
        return res.status(500).json({ error: 'Error al subir captura' });
    }

    const { data: { publicUrl } } = supabase.storage
        .from('deposit-screenshots')
        .getPublicUrl(filePath);

    const { data: request, error: insertError } = await supabase
        .from('deposit_requests')
        .insert({
            user_id: parseInt(userId),
            method_id: parseInt(methodId),
            screenshot_url: publicUrl,
            amount: amount,
            currency,
            status: 'pending'
        })
        .select()
        .single();

    if (insertError) {
        return res.status(500).json({ error: 'Error al guardar solicitud' });
    }

    for (const adminId of ADMIN_IDS) {
        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: adminId,
                text: `📥 <b>Nueva solicitud de DEPÓSITO</b> (WebApp)\n👤 Usuario: ${user.first_name} (${userId})\n🏦 Método: ${method.name} (${currency})\n💰 Monto: ${amount}\n📎 <a href="${publicUrl}">Ver captura</a>\n🆔 Solicitud: ${request.id}`,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Aprobar', callback_data: `approve_deposit_${request.id}` },
                        { text: '❌ Rechazar', callback_data: `reject_deposit_${request.id}` }
                    ]]
                }
            });
        } catch (e) {
            console.error('Error enviando notificación de depósito:', e);
        }
    }

    res.json({ success: true, requestId: request.id });
});

// --- Solicitud de retiro ---
app.post('/api/withdraw-requests', async (req, res) => {
    const { methodId, amount, currency, userId, accountInfo } = req.body;
    if (!methodId || !amount || !currency || !userId || !accountInfo) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    const user = await getOrCreateUser(parseInt(userId));
    const { data: method } = await supabase
        .from('withdraw_methods')
        .select('*')
        .eq('id', methodId)
        .single();

    if (!method) {
        return res.status(400).json({ error: 'Método no encontrado' });
    }

    if (method.currency !== currency) {
        return res.status(400).json({ error: `La moneda del método es ${method.currency}, no coincide.` });
    }

    // Verificar saldo disponible
    let saldoSuficiente = false;
    let saldoMensaje = '';
    if (currency === 'CUP') {
        if (parseFloat(user.cup) >= amount) saldoSuficiente = true;
        else saldoMensaje = `Saldo CUP insuficiente. Disponible: ${parseFloat(user.cup).toFixed(2)} CUP`;
    } else if (currency === 'USD') {
        if (parseFloat(user.usd) >= amount) saldoSuficiente = true;
        else saldoMensaje = `Saldo USD insuficiente. Disponible: ${parseFloat(user.usd).toFixed(2)} USD`;
    } else {
        const cupNeeded = await convertToCUP(amount, currency);
        if (parseFloat(user.cup) >= cupNeeded) saldoSuficiente = true;
        else saldoMensaje = `Saldo CUP insuficiente. Necesitas ${cupNeeded.toFixed(2)} CUP.`;
    }

    if (!saldoSuficiente) {
        return res.status(400).json({ error: saldoMensaje });
    }

    if (method.min_amount !== null && amount < method.min_amount) {
        return res.status(400).json({ error: `Monto mínimo: ${method.min_amount} ${currency}` });
    }
    if (method.max_amount !== null && amount > method.max_amount) {
        return res.status(400).json({ error: `Monto máximo: ${method.max_amount} ${currency}` });
    }

    const { data: request, error: insertError } = await supabase
        .from('withdraw_requests')
        .insert({
            user_id: parseInt(userId),
            method_id: parseInt(methodId),
            amount,
            currency,
            account_info: accountInfo,
            status: 'pending'
        })
        .select()
        .single();

    if (insertError) {
        return res.status(500).json({ error: 'Error al crear solicitud' });
    }

    for (const adminId of ADMIN_IDS) {
        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                chat_id: adminId,
                text: `📤 <b>Nueva solicitud de RETIRO</b> (WebApp)\n👤 Usuario: ${user.first_name} (${userId})\n💰 Monto: ${amount} ${currency}\n🏦 Método: ${method.name} (${currency})\n📞 Cuenta: ${accountInfo}\n🆔 Solicitud: ${request.id}`,
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: '✅ Aprobar', callback_data: `approve_withdraw_${request.id}` },
                        { text: '❌ Rechazar', callback_data: `reject_withdraw_${request.id}` }
                    ]]
                }
            });
        } catch (e) {}
    }

    res.json({ success: true, requestId: request.id });
});

// --- Transferencia entre usuarios ---
app.post('/api/transfer', async (req, res) => {
    const { from, to, amount, currency } = req.body;
    if (!from || !to || !amount || !currency || amount <= 0) {
        return res.status(400).json({ error: 'Datos inválidos' });
    }
    if (!['CUP', 'USD'].includes(currency)) {
        return res.status(400).json({ error: 'Solo se permite transferir CUP o USD' });
    }
    if (from === to) {
        return res.status(400).json({ error: 'No puedes transferirte a ti mismo' });
    }

    const userFrom = await getOrCreateUser(parseInt(from));
    if (!userFrom) return res.status(404).json({ error: 'Usuario origen no encontrado' });

    // Buscar usuario destino
    let targetUserId = null;
    let targetUser = null;
    if (!isNaN(to) && typeof to === 'number' || !isNaN(parseInt(to))) {
        targetUserId = parseInt(to);
        const { data } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', targetUserId)
            .single();
        targetUser = data;
    } else {
        let username = to.replace(/^@/, '');
        const { data } = await supabase
            .from('users')
            .select('*')
            .eq('username', username)
            .maybeSingle();
        if (data) {
            targetUser = data;
            targetUserId = data.telegram_id;
        }
    }
    if (!targetUser) {
        return res.status(404).json({ error: 'Usuario destino no encontrado' });
    }

    // Verificar saldo origen
    if (currency === 'CUP') {
        if (parseFloat(userFrom.cup) < amount) {
            return res.status(400).json({ error: 'Saldo CUP insuficiente' });
        }
    } else {
        if (parseFloat(userFrom.usd) < amount) {
            return res.status(400).json({ error: 'Saldo USD insuficiente' });
        }
    }

    // Realizar transferencia
    if (currency === 'CUP') {
        await supabase
            .from('users')
            .update({ cup: parseFloat(userFrom.cup) - amount, updated_at: new Date() })
            .eq('telegram_id', from);
        await supabase
            .from('users')
            .update({ cup: parseFloat(targetUser.cup) + amount, updated_at: new Date() })
            .eq('telegram_id', targetUserId);
    } else {
        await supabase
            .from('users')
            .update({ usd: parseFloat(userFrom.usd) - amount, updated_at: new Date() })
            .eq('telegram_id', from);
        await supabase
            .from('users')
            .update({ usd: parseFloat(targetUser.usd) + amount, updated_at: new Date() })
            .eq('telegram_id', targetUserId);
    }

    res.json({ success: true });
});

// --- Registro de apuestas ---
app.post('/api/bets', async (req, res) => {
    const { userId, lottery, betType, rawText, sessionId } = req.body;
    if (!userId || !lottery || !betType || !rawText) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    if (sessionId) {
        const { data: activeSession } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('id', sessionId)
            .eq('status', 'open')
            .maybeSingle();
        if (!activeSession) {
            return res.status(400).json({ error: 'La sesión de juego no está activa' });
        }
    }

    const user = await getOrCreateUser(parseInt(userId));
    const parsed = parseBetMessage(rawText, betType);
    if (!parsed.ok) {
        return res.status(400).json({ error: 'No se pudo interpretar la apuesta' });
    }

    const totalUSD = parsed.totalUSD;
    const totalCUP = parsed.totalCUP;
    if (totalUSD === 0 && totalCUP === 0) {
        return res.status(400).json({ error: 'Debes especificar un monto válido' });
    }

    const { data: priceData } = await supabase
        .from('play_prices')
        .select('min_cup, min_usd, max_cup, max_usd')
        .eq('bet_type', betType)
        .single();

    const minCup = priceData?.min_cup || 0;
    const minUsd = priceData?.min_usd || 0;
    const maxCup = priceData?.max_cup;
    const maxUsd = priceData?.max_usd;

    for (const item of parsed.items) {
        if (item.currency === 'CUP') {
            if (item.amount < minCup) {
                return res.status(400).json({ error: `Mínimo en CUP: ${minCup}` });
            }
            if (maxCup !== null && item.amount > maxCup) {
                return res.status(400).json({ error: `Máximo en CUP: ${maxCup}` });
            }
        } else if (item.currency === 'USD') {
            if (item.amount < minUsd) {
                return res.status(400).json({ error: `Mínimo en USD: ${minUsd}` });
            }
            if (maxUsd !== null && item.amount > maxUsd) {
                return res.status(400).json({ error: `Máximo en USD: ${maxUsd}` });
            }
        }
    }

    let newUsd = parseFloat(user.usd) || 0;
    let newBonus = parseFloat(user.bonus_cup) || 0;
    let newCup = parseFloat(user.cup) || 0;

    if (totalUSD > 0) {
        const totalDisponible = newUsd + newBonus / (await getExchangeRateUSD());
        if (totalDisponible < totalUSD) {
            return res.status(400).json({ error: 'Saldo USD insuficiente' });
        }
        const bonoEnUSD = newBonus / (await getExchangeRateUSD());
        const usarBonoUSD = Math.min(bonoEnUSD, totalUSD);
        newBonus -= usarBonoUSD * (await getExchangeRateUSD());
        newUsd -= (totalUSD - usarBonoUSD);
    }

    if (totalCUP > 0) {
        if (newCup < totalCUP) {
            return res.status(400).json({ error: 'Saldo CUP insuficiente' });
        }
        newCup -= totalCUP;
    }

    await supabase
        .from('users')
        .update({
            usd: newUsd,
            bonus_cup: newBonus,
            cup: newCup,
            updated_at: new Date()
        })
        .eq('telegram_id', userId);

    const { data: bet, error: betError } = await supabase
        .from('bets')
        .insert({
            user_id: parseInt(userId),
            lottery,
            session_id: sessionId || null,
            bet_type: betType,
            raw_text: rawText,
            items: parsed.items,
            placed_at: new Date()
        })
        .select()
        .single();

    if (betError) {
        console.error('Error insertando apuesta:', betError);
        return res.status(500).json({ error: 'Error al registrar la apuesta' });
    }

    const updatedUser = await getOrCreateUser(parseInt(userId));
    res.json({ success: true, bet, updatedUser });
});

// --- Cancelar jugada ---
app.post('/api/bets/:id/cancel', async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'Falta userId' });

    const { data: bet } = await supabase
        .from('bets')
        .select('*')
        .eq('id', id)
        .eq('user_id', userId)
        .single();

    if (!bet) return res.status(404).json({ error: 'Jugada no encontrada' });

    if (bet.session_id) {
        const { data: session } = await supabase
            .from('lottery_sessions')
            .select('status')
            .eq('id', bet.session_id)
            .single();
        if (!session || session.status !== 'open') {
            return res.status(400).json({ error: 'No se puede cancelar: sesión cerrada' });
        }
    }

    const user = await getOrCreateUser(parseInt(userId));
    let newCup = parseFloat(user.cup) || 0;
    let newUsd = parseFloat(user.usd) || 0;
    let newBonus = parseFloat(user.bonus_cup) || 0;

    for (const item of bet.items) {
        if (item.currency === 'CUP') {
            newCup += item.amount;
        } else if (item.currency === 'USD') {
            newUsd += item.amount;
        }
    }

    await supabase
        .from('users')
        .update({ usd: newUsd, cup: newCup, bonus_cup: newBonus, updated_at: new Date() })
        .eq('telegram_id', userId);

    await supabase
        .from('bets')
        .delete()
        .eq('id', id);

    const updatedUser = await getOrCreateUser(parseInt(userId));
    res.json({ success: true, updatedUser });
});

// --- Historial de apuestas ---
app.get('/api/user/:userId/bets', async (req, res) => {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const { data } = await supabase
        .from('bets')
        .select('*')
        .eq('user_id', userId)
        .order('placed_at', { ascending: false })
        .limit(limit);
    res.json(data || []);
});

// --- Cantidad de referidos ---
app.get('/api/user/:userId/referrals/count', async (req, res) => {
    const { userId } = req.params;
    const { count } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('ref_by', userId);
    res.json({ count: count || 0 });
});

// ========== ENDPOINTS DE ADMIN ==========

// --- Añadir método de depósito ---
app.post('/api/admin/deposit-methods', requireAdmin, async (req, res) => {
    const { name, card, confirm, currency, min_amount, max_amount } = req.body;
    if (!name || !card || !confirm || !currency) {
        return res.status(400).json({ error: 'Faltan campos obligatorios' });
    }
    const validCurrencies = ['CUP', 'USD', 'USDT', 'TRX', 'MLC'];
    if (!validCurrencies.includes(currency)) {
        return res.status(400).json({ error: 'Moneda no válida' });
    }
    const insertData = {
        name,
        card,
        confirm,
        currency,
        min_amount: min_amount !== undefined ? (min_amount === 0 ? null : min_amount) : null,
        max_amount: max_amount !== undefined ? (max_amount === 0 ? null : max_amount) : null
    };
    const { data, error } = await supabase
        .from('deposit_methods')
        .insert(insertData)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- Editar método de depósito ---
app.put('/api/admin/deposit-methods/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, card, confirm, currency, min_amount, max_amount } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (card !== undefined) updateData.card = card;
    if (confirm !== undefined) updateData.confirm = confirm;
    if (currency !== undefined) {
        const validCurrencies = ['CUP', 'USD', 'USDT', 'TRX', 'MLC'];
        if (!validCurrencies.includes(currency)) return res.status(400).json({ error: 'Moneda no válida' });
        updateData.currency = currency;
    }
    if (min_amount !== undefined) updateData.min_amount = min_amount === 0 ? null : min_amount;
    if (max_amount !== undefined) updateData.max_amount = max_amount === 0 ? null : max_amount;
    updateData.updated_at = new Date();

    const { data, error } = await supabase
        .from('deposit_methods')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- Eliminar método de depósito ---
app.delete('/api/admin/deposit-methods/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase
        .from('deposit_methods')
        .delete()
        .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// --- Añadir método de retiro ---
app.post('/api/admin/withdraw-methods', requireAdmin, async (req, res) => {
    const { name, card, confirm, currency, min_amount, max_amount } = req.body;
    if (!name || !card || !currency) {
        return res.status(400).json({ error: 'Nombre, instrucción y moneda obligatorios' });
    }
    const validCurrencies = ['CUP', 'USD', 'USDT', 'TRX', 'MLC'];
    if (!validCurrencies.includes(currency)) {
        return res.status(400).json({ error: 'Moneda no válida' });
    }
    const insertData = {
        name,
        card,
        confirm: confirm || 'ninguno',
        currency,
        min_amount: min_amount !== undefined ? (min_amount === 0 ? null : min_amount) : null,
        max_amount: max_amount !== undefined ? (max_amount === 0 ? null : max_amount) : null
    };
    const { data, error } = await supabase
        .from('withdraw_methods')
        .insert(insertData)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- Editar método de retiro ---
app.put('/api/admin/withdraw-methods/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, card, confirm, currency, min_amount, max_amount } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (card !== undefined) updateData.card = card;
    if (confirm !== undefined) updateData.confirm = confirm;
    if (currency !== undefined) {
        const validCurrencies = ['CUP', 'USD', 'USDT', 'TRX', 'MLC'];
        if (!validCurrencies.includes(currency)) return res.status(400).json({ error: 'Moneda no válida' });
        updateData.currency = currency;
    }
    if (min_amount !== undefined) updateData.min_amount = min_amount === 0 ? null : min_amount;
    if (max_amount !== undefined) updateData.max_amount = max_amount === 0 ? null : max_amount;
    updateData.updated_at = new Date();

    const { data, error } = await supabase
        .from('withdraw_methods')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// --- Eliminar método de retiro ---
app.delete('/api/admin/withdraw-methods/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { error } = await supabase
        .from('withdraw_methods')
        .delete()
        .eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// --- Actualizar tasas de cambio ---
app.put('/api/admin/exchange-rate/usd', requireAdmin, async (req, res) => {
    const { rate } = req.body;
    if (!rate || rate <= 0) return res.status(400).json({ error: 'Tasa inválida' });
    await setExchangeRateUSD(rate);
    res.json({ success: true });
});

app.put('/api/admin/exchange-rate/usdt', requireAdmin, async (req, res) => {
    const { rate } = req.body;
    if (!rate || rate <= 0) return res.status(400).json({ error: 'Tasa inválida' });
    await setExchangeRateUSDT(rate);
    res.json({ success: true });
});

app.put('/api/admin/exchange-rate/trx', requireAdmin, async (req, res) => {
    const { rate } = req.body;
    if (!rate || rate <= 0) return res.status(400).json({ error: 'Tasa inválida' });
    await setExchangeRateTRX(rate);
    res.json({ success: true });
});

// --- Actualizar precios de jugada ---
app.put('/api/admin/play-prices/:betType', requireAdmin, async (req, res) => {
    const { betType } = req.params;
    const { payout_multiplier, min_cup, min_usd, max_cup, max_usd } = req.body;
    const updateData = { updated_at: new Date() };
    if (payout_multiplier !== undefined) updateData.payout_multiplier = payout_multiplier;
    if (min_cup !== undefined) updateData.min_cup = min_cup;
    if (min_usd !== undefined) updateData.min_usd = min_usd;
    if (max_cup !== undefined) updateData.max_cup = max_cup === 0 ? null : max_cup;
    if (max_usd !== undefined) updateData.max_usd = max_usd === 0 ? null : max_usd;

    const { error } = await supabase
        .from('play_prices')
        .update(updateData)
        .eq('bet_type', betType);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// --- Configurar mínimo depósito ---
app.post('/api/admin/min-deposit', requireAdmin, async (req, res) => {
    const { value } = req.body;
    if (!value || value <= 0) return res.status(400).json({ error: 'Valor inválido' });
    await setMinDepositUSD(value);
    res.json({ success: true });
});

// --- Configurar mínimo retiro ---
app.post('/api/admin/min-withdraw', requireAdmin, async (req, res) => {
    const { value } = req.body;
    if (!value || value <= 0) return res.status(400).json({ error: 'Valor inválido' });
    await setMinWithdrawUSD(value);
    res.json({ success: true });
});

// --- Obtener sesiones de una fecha ---
app.get('/api/admin/lottery-sessions', requireAdmin, async (req, res) => {
    const { date } = req.query;
    if (!date) return res.status(400).json({ error: 'Falta fecha' });
    const { data } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('date', date);
    res.json(data || []);
});

// --- Crear nueva sesión ---
app.post('/api/admin/lottery-sessions', requireAdmin, async (req, res) => {
    const { lottery, time_slot } = req.body;
    if (!lottery || !time_slot) return res.status(400).json({ error: 'Faltan datos' });

    const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
    const endTime = getEndTimeFromSlot(lottery, time_slot);
    if (!endTime) {
        return res.status(400).json({ error: `La hora de cierre para el turno ${time_slot} ya pasó hoy.` });
    }

    const { data: existing } = await supabase
        .from('lottery_sessions')
        .select('id')
        .eq('lottery', lottery)
        .eq('date', today)
        .eq('time_slot', time_slot)
        .maybeSingle();

    if (existing) {
        return res.status(400).json({ error: 'Ya existe una sesión para este turno hoy' });
    }

    const { data, error } = await supabase
        .from('lottery_sessions')
        .insert({
            lottery,
            date: today,
            time_slot,
            status: 'open',
            end_time: endTime.toISOString()
        })
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    const region = regionMap[lottery];
    await broadcastToAllUsers(
        `🎲 <b>¡SESIÓN ABIERTA!</b> 🎲\n\n` +
        `✨ La región ${region?.emoji || '🎰'} <b>${lottery}</b> acaba de abrir su turno de <b>${time_slot}</b>.\n` +
        `💎 ¡Es tu momento! Realiza tus apuestas y llévate grandes premios.\n\n` +
        `⏰ Cierre: ${moment(endTime).tz(TIMEZONE).format('HH:mm')} (hora Cuba)\n` +
        `🍀 ¡La suerte te espera!`
    );

    res.json(data);
});

// --- Cambiar estado de sesión ---
app.post('/api/admin/lottery-sessions/toggle', requireAdmin, async (req, res) => {
    const { sessionId, status } = req.body;
    if (!sessionId || !status) return res.status(400).json({ error: 'Faltan datos' });
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });

    const { data, error } = await supabase
        .from('lottery_sessions')
        .update({ status, updated_at: new Date() })
        .eq('id', sessionId)
        .select()
        .single();

    if (error) return res.status(500).json({ error: error.message });

    const region = regionMap[data.lottery];
    if (status === 'closed') {
        await broadcastToAllUsers(
            `🔴 <b>SESIÓN CERRADA</b>\n\n` +
            `🎰 ${region?.emoji || '🎰'} <b>${data.lottery}</b> - Turno <b>${data.time_slot}</b>\n` +
            `📅 Fecha: ${data.date}\n\n` +
            `❌ Ya no se reciben más apuestas.\n` +
            `🔢 Pronto anunciaremos el número ganador. ¡Mantente atento!`
        );
    }

    res.json(data);
});

// --- Obtener sesiones cerradas ---
app.get('/api/admin/lottery-sessions/closed', requireAdmin, async (req, res) => {
    const { data } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('status', 'closed')
        .order('date', { ascending: false });
    res.json(data || []);
});

// --- Obtener ganadores de una sesión ---
app.get('/api/admin/winning-numbers/:sessionId/winners', requireAdmin, async (req, res) => {
    const { sessionId } = req.params;

    const { data: session } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

    const { data: winning } = await supabase
        .from('winning_numbers')
        .select('numbers')
        .eq('lottery', session.lottery)
        .eq('date', session.date)
        .eq('time_slot', session.time_slot)
        .maybeSingle();

    if (!winning) {
        return res.json({ winners: [], message: 'Aún no hay número ganador' });
    }

    const winningStr = winning.numbers[0];
    const centena = winningStr.slice(0, 3);
    const cuarteta = winningStr.slice(3);
    const fijo = centena.slice(1);
    const corridos = [
        fijo,
        cuarteta.slice(0, 2),
        cuarteta.slice(2)
    ];
    const parles = [
        `${corridos[0]}x${corridos[1]}`,
        `${corridos[0]}x${corridos[2]}`,
        `${corridos[1]}x${corridos[2]}`
    ];

    const { data: multipliers } = await supabase
        .from('play_prices')
        .select('bet_type, payout_multiplier');
    const multiplierMap = {};
    multipliers.forEach(m => { multiplierMap[m.bet_type] = parseFloat(m.payout_multiplier) || 0; });

    const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('session_id', sessionId);

    const winners = [];

    for (const bet of bets || []) {
        let premioTotalUSD = 0;
        let premioTotalCUP = 0;
        const items = bet.items || [];

        for (const item of items) {
            const numero = item.numero;
            const multiplicador = multiplierMap[bet.bet_type] || 0;
            let ganado = false;

            switch (bet.bet_type) {
                case 'fijo':
                    if (numero.startsWith('D')) {
                        const digito = numero[1];
                        if (fijo.startsWith(digito)) ganado = true;
                    } else if (numero.startsWith('T')) {
                        const digito = numero[1];
                        if (fijo.endsWith(digito)) ganado = true;
                    } else {
                        if (numero === fijo) ganado = true;
                    }
                    break;
                case 'corridos':
                    if (corridos.includes(numero)) ganado = true;
                    break;
                case 'centena':
                    if (numero === centena) ganado = true;
                    break;
                case 'parle':
                    if (parles.includes(numero)) ganado = true;
                    break;
            }

            if (ganado) {
                if (item.currency === 'USD') premioTotalUSD += item.amount * multiplicador;
                else if (item.currency === 'CUP') premioTotalCUP += item.amount * multiplicador;
            }
        }

        if (premioTotalUSD > 0 || premioTotalCUP > 0) {
            const { data: user } = await supabase
                .from('users')
                .select('first_name')
                .eq('telegram_id', bet.user_id)
                .single();

            winners.push({
                user_id: bet.user_id,
                first_name: user?.first_name || 'Usuario',
                prize_usd: premioTotalUSD,
                prize_cup: premioTotalCUP,
                bet_text: bet.raw_text
            });
        }
    }

    res.json({ winners, winning_number: winningStr });
});

// --- Publicar número ganador ---
app.post('/api/admin/winning-numbers', requireAdmin, async (req, res) => {
    const { sessionId, winningNumber } = req.body;
    if (!sessionId || !winningNumber) return res.status(400).json({ error: 'Faltan datos' });

    const cleanNumber = winningNumber.replace(/\s+/g, '');
    if (!/^\d{7}$/.test(cleanNumber)) {
        return res.status(400).json({ error: 'El número debe tener exactamente 7 dígitos' });
    }

    const { data: session } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

    if (!session) return res.status(404).json({ error: 'Sesión no encontrada' });

    const { data: existingWin } = await supabase
        .from('winning_numbers')
        .select('id')
        .eq('lottery', session.lottery)
        .eq('date', session.date)
        .eq('time_slot', session.time_slot)
        .maybeSingle();

    if (existingWin) {
        return res.status(400).json({ error: 'Esta sesión ya tiene un número ganador publicado' });
    }

    const centena = cleanNumber.slice(0, 3);
    const cuarteta = cleanNumber.slice(3);
    const fijo = centena.slice(1);
    const corridos = [
        fijo,
        cuarteta.slice(0, 2),
        cuarteta.slice(2)
    ];
    const parles = [
        `${corridos[0]}x${corridos[1]}`,
        `${corridos[0]}x${corridos[2]}`,
        `${corridos[1]}x${corridos[2]}`
    ];

    const { error: insertError } = await supabase
        .from('winning_numbers')
        .insert({
            lottery: session.lottery,
            date: session.date,
            time_slot: session.time_slot,
            numbers: [cleanNumber],
            published_at: new Date()
        });

    if (insertError) return res.status(500).json({ error: insertError.message });

    const { data: multipliers } = await supabase
        .from('play_prices')
        .select('bet_type, payout_multiplier');
    const multiplierMap = {};
    multipliers.forEach(m => { multiplierMap[m.bet_type] = parseFloat(m.payout_multiplier) || 0; });

    const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('session_id', sessionId);

    const rates = await getExchangeRates();

    for (const bet of bets || []) {
        let premioTotalUSD = 0;
        let premioTotalCUP = 0;
        const items = bet.items || [];

        for (const item of items) {
            const numero = item.numero;
            const multiplicador = multiplierMap[bet.bet_type] || 0;
            let ganado = false;

            switch (bet.bet_type) {
                case 'fijo':
                    if (numero.startsWith('D')) {
                        const digito = numero[1];
                        if (fijo.startsWith(digito)) ganado = true;
                    } else if (numero.startsWith('T')) {
                        const digito = numero[1];
                        if (fijo.endsWith(digito)) ganado = true;
                    } else {
                        if (numero === fijo) ganado = true;
                    }
                    break;
                case 'corridos':
                    if (corridos.includes(numero)) ganado = true;
                    break;
                case 'centena':
                    if (numero === centena) ganado = true;
                    break;
                case 'parle':
                    if (parles.includes(numero)) ganado = true;
                    break;
            }

            if (ganado) {
                if (item.currency === 'USD') premioTotalUSD += item.amount * multiplicador;
                else if (item.currency === 'CUP') premioTotalCUP += item.amount * multiplicador;
            }
        }

        if (premioTotalUSD > 0 || premioTotalCUP > 0) {
            const { data: user } = await supabase
                .from('users')
                .select('usd, cup')
                .eq('telegram_id', bet.user_id)
                .single();

            let newUsd = parseFloat(user.usd) + premioTotalUSD;
            let newCup = parseFloat(user.cup) + premioTotalCUP;

            await supabase
                .from('users')
                .update({ usd: newUsd, cup: newCup, updated_at: new Date() })
                .eq('telegram_id', bet.user_id);

            const formatted = cleanNumber.replace(/(\d{3})(\d{4})/, '$1 $2');
            try {
                await bot.telegram.sendMessage(bet.user_id,
                    `🎉 <b>¡FELICIDADES! Has ganado</b>\n\n` +
                    `🔢 Número ganador: <code>${formatted}</code>\n` +
                    `🎰 ${regionMap[session.lottery]?.emoji || '🎰'} ${session.lottery} - ${session.time_slot}\n` +
                    `💰 Premio: ${premioTotalUSD > 0 ? premioTotalUSD.toFixed(2) + ' USD' : ''} ${premioTotalCUP > 0 ? premioTotalCUP.toFixed(2) + ' CUP' : ''}\n` +
                    `✅ El premio ya fue acreditado a tu saldo.`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {}
        } else {
            const formatted = cleanNumber.replace(/(\d{3})(\d{4})/, '$1 $2');
            try {
                await bot.telegram.sendMessage(bet.user_id,
                    `🔢 <b>Números ganadores de ${regionMap[session.lottery]?.emoji || '🎰'} ${session.lottery} (${session.date} - ${session.time_slot})</b>\n\n` +
                    `Número: <code>${formatted}</code>\n\n` +
                    `😔 No has ganado esta vez. ¡Sigue intentando!`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {}
        }
    }

    const formattedBroadcast = cleanNumber.replace(/(\d{3})(\d{4})/, '$1 $2');
    await broadcastToAllUsers(
        `📢 <b>NÚMERO GANADOR PUBLICADO</b>\n\n` +
        `🎰 ${regionMap[session.lottery]?.emoji || '🎰'} <b>${session.lottery}</b> - Turno <b>${session.time_slot}</b>\n` +
        `📅 Fecha: ${session.date}\n` +
        `🔢 Número: <code>${formattedBroadcast}</code>\n\n` +
        `💬 Revisa tu historial para ver si has ganado. ¡Suerte en la próxima!`
    );

    res.json({ success: true, message: 'Números publicados y premios calculados' });
});

// ========== NUEVOS ENDPOINTS PARA SOLICITUDES PENDIENTES ==========

// --- Listar solicitudes de depósito pendientes ---
app.get('/api/admin/pending-deposits', requireAdmin, async (req, res) => {
    const { data, error } = await supabase
        .from('deposit_requests')
        .select(`
            id,
            user_id,
            amount,
            currency,
            screenshot_url,
            status,
            created_at,
            users (first_name, username),
            deposit_methods (name, card, confirm)
        `)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const formatted = data.map(d => ({
        id: d.id,
        user_id: d.user_id,
        user_name: d.users?.first_name || 'Desconocido',
        username: d.users?.username,
        amount: d.amount,
        currency: d.currency,
        screenshot_url: d.screenshot_url,
        method_name: d.deposit_methods?.name,
        method_card: d.deposit_methods?.card,
        method_confirm: d.deposit_methods?.confirm,
        created_at: d.created_at
    }));

    res.json(formatted);
});

// --- Aprobar solicitud de depósito ---
app.post('/api/admin/pending-deposits/:id/approve', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body; // ID del admin que aprueba

    // Obtener la solicitud
    const { data: request, error: fetchError } = await supabase
        .from('deposit_requests')
        .select('*')
        .eq('id', id)
        .eq('status', 'pending')
        .single();

    if (fetchError || !request) {
        return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }

    // Actualizar saldo del usuario
    const user = await getOrCreateUser(request.user_id);
    let newCup = parseFloat(user.cup) || 0;
    let newUsd = parseFloat(user.usd) || 0;
    let newBonus = parseFloat(user.bonus_cup) || 0;

    // Convertir el monto a CUP si es necesario (los depósitos siempre incrementan CUP o USD según la moneda)
    if (request.currency === 'CUP') {
        newCup += parseFloat(request.amount);
    } else if (request.currency === 'USD') {
        newUsd += parseFloat(request.amount);
    } else {
        // Para otras monedas, convertir a CUP usando la tasa actual
        const cupAmount = await convertToCUP(parseFloat(request.amount), request.currency);
        newCup += cupAmount;
    }

    await supabase
        .from('users')
        .update({ cup: newCup, usd: newUsd, updated_at: new Date() })
        .eq('telegram_id', request.user_id);

    // Marcar solicitud como aprobada
    const { error: updateError } = await supabase
        .from('deposit_requests')
        .update({ status: 'approved', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ error: updateError.message });
    }

    // Notificar al usuario
    try {
        await bot.telegram.sendMessage(request.user_id,
            `✅ <b>¡Depósito aprobado!</b>\n\n` +
            `💰 Monto: ${request.amount} ${request.currency}\n` +
            `📌 El saldo ya ha sido acreditado a tu cuenta.`,
            { parse_mode: 'HTML' }
        );
    } catch (e) {}

    res.json({ success: true });
});

// --- Rechazar solicitud de depósito ---
app.post('/api/admin/pending-deposits/:id/reject', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;

    const { data: request, error: fetchError } = await supabase
        .from('deposit_requests')
        .select('*')
        .eq('id', id)
        .eq('status', 'pending')
        .single();

    if (fetchError || !request) {
        return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }

    // Marcar como rechazada
    const { error: updateError } = await supabase
        .from('deposit_requests')
        .update({ status: 'rejected', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ error: updateError.message });
    }

    // Notificar al usuario
    try {
        await bot.telegram.sendMessage(request.user_id,
            `❌ <b>Depósito rechazado</b>\n\n` +
            `💰 Monto: ${request.amount} ${request.currency}\n` +
            `📌 Por favor, contacta con el administrador si tienes dudas.`,
            { parse_mode: 'HTML' }
        );
    } catch (e) {}

    res.json({ success: true });
});

// --- Listar solicitudes de retiro pendientes ---
app.get('/api/admin/pending-withdraws', requireAdmin, async (req, res) => {
    const { data, error } = await supabase
        .from('withdraw_requests')
        .select(`
            id,
            user_id,
            amount,
            currency,
            account_info,
            status,
            created_at,
            users (first_name, username),
            withdraw_methods (name, card, confirm)
        `)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const formatted = data.map(w => ({
        id: w.id,
        user_id: w.user_id,
        user_name: w.users?.first_name || 'Desconocido',
        username: w.users?.username,
        amount: w.amount,
        currency: w.currency,
        account_info: w.account_info,
        method_name: w.withdraw_methods?.name,
        method_card: w.withdraw_methods?.card,
        method_confirm: w.withdraw_methods?.confirm,
        created_at: w.created_at
    }));

    res.json(formatted);
});

// --- Aprobar solicitud de retiro ---
app.post('/api/admin/pending-withdraws/:id/approve', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;

    const { data: request, error: fetchError } = await supabase
        .from('withdraw_requests')
        .select('*')
        .eq('id', id)
        .eq('status', 'pending')
        .single();

    if (fetchError || !request) {
        return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }

    // El saldo ya se verificó al crear la solicitud, así que solo marcamos como aprobado
    // (Opcional: podríamos descontar aquí, pero ya se descontó al crear la solicitud, según tu lógica actual)
    // En tu implementación actual, el saldo NO se descuenta al crear la solicitud, solo se verifica.
    // Por lo tanto, al aprobar debemos descontar el saldo.

    const user = await getOrCreateUser(request.user_id);
    let newCup = parseFloat(user.cup) || 0;
    let newUsd = parseFloat(user.usd) || 0;

    if (request.currency === 'CUP') {
        newCup -= parseFloat(request.amount);
    } else if (request.currency === 'USD') {
        newUsd -= parseFloat(request.amount);
    } else {
        const cupAmount = await convertToCUP(parseFloat(request.amount), request.currency);
        newCup -= cupAmount;
    }

    if (newCup < 0 || newUsd < 0) {
        return res.status(400).json({ error: 'Saldo insuficiente (posible cambio de tasa). Rechace la solicitud.' });
    }

    await supabase
        .from('users')
        .update({ cup: newCup, usd: newUsd, updated_at: new Date() })
        .eq('telegram_id', request.user_id);

    const { error: updateError } = await supabase
        .from('withdraw_requests')
        .update({ status: 'approved', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ error: updateError.message });
    }

    try {
        await bot.telegram.sendMessage(request.user_id,
            `✅ <b>¡Retiro aprobado!</b>\n\n` +
            `💰 Monto: ${request.amount} ${request.currency}\n` +
            `📌 Los fondos han sido enviados a tu cuenta.`,
            { parse_mode: 'HTML' }
        );
    } catch (e) {}

    res.json({ success: true });
});

// --- Rechazar solicitud de retiro ---
app.post('/api/admin/pending-withdraws/:id/reject', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;

    const { data: request, error: fetchError } = await supabase
        .from('withdraw_requests')
        .select('*')
        .eq('id', id)
        .eq('status', 'pending')
        .single();

    if (fetchError || !request) {
        return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }

    // Simplemente rechazar, no se modifica saldo
    const { error: updateError } = await supabase
        .from('withdraw_requests')
        .update({ status: 'rejected', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id);

    if (updateError) {
        return res.status(500).json({ error: updateError.message });
    }

    try {
        await bot.telegram.sendMessage(request.user_id,
            `❌ <b>Retiro rechazado</b>\n\n` +
            `💰 Monto: ${request.amount} ${request.currency}\n` +
            `📌 Contacta con el administrador para más información.`,
            { parse_mode: 'HTML' }
        );
    } catch (e) {}

    res.json({ success: true });
});

// ========== SERVIDOR ESTÁTICO ==========
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'webapp', 'index.html'));
});
app.get('/app.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'webapp', 'app.html'));
});

// ========== KEEP-ALIVE ==========
setInterval(async () => {
    try {
        await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`);
        console.log('[Keep-Alive] Ping a Telegram OK');
    } catch (e) {
        console.error('[Keep-Alive] Error:', e.message);
    }
}, 5 * 60 * 1000);

// ========== INICIAR SERVIDOR Y BOT ==========
app.listen(PORT, () => {
    console.log(`🚀 Backend de 4pu3$t4$_Qva corriendo en http://localhost:${PORT}`);
    console.log(`📡 WebApp servida en ${WEBAPP_URL}`);
    console.log(`🤖 Iniciando bot de Telegram...`);
});

bot.launch()
    .then(() => console.log('🤖 Bot de Telegram iniciado correctamente'))
    .catch(err => console.error('❌ Error al iniciar el bot:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

module.exports = app;
