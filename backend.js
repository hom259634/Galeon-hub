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
let bot; // will be loaded asynchronously via dynamic import to avoid ESM TLA errors

// ========== CONFIGURACIÓN DESDE .ENV ==========
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BONUS_CUP_DEFAULT = parseFloat(process.env.BONUS_CUP_DEFAULT) || 70;
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const TIMEZONE = process.env.TIMEZONE || 'America/Havana';
const BOT_LAUNCH_MAX_RETRIES = parseInt(process.env.BOT_LAUNCH_MAX_RETRIES || '0', 10); // 0 = infinito
const BOT_LAUNCH_RETRY_BASE_MS = parseInt(process.env.BOT_LAUNCH_RETRY_BASE_MS || '5000', 10);
const BOT_LAUNCH_RETRY_MAX_MS = parseInt(process.env.BOT_LAUNCH_RETRY_MAX_MS || '120000', 10);

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

async function userHasApprovedDeposit(telegramId) {
    try {
        const { count, error } = await supabase
            .from('deposit_requests')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', parseInt(telegramId))
            .eq('status', 'approved');

        if (error) {
            console.error('Error verificando depósitos aprobados:', error);
            return false;
        }

        return (count || 0) > 0;
    } catch (e) {
        console.error('Excepción verificando depósitos aprobados:', e);
        return false;
    }
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
        .select('*')
        .eq('id', 1)
        .single();
    return {
        rate: data?.rate ?? 110,
        rate_usdt: data?.rate_usdt ?? 110,
        rate_trx: data?.rate_trx ?? 1,
        rate_mlc: data?.rate_mlc ?? 110
    };
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

async function getExchangeRateMLC() {
    const rates = await getExchangeRates();
    return rates.rate_mlc;
}

async function setExchangeRateUSD(rate) {
    await supabase
        // Acreditar destino y migrar bono si existe (misma lógica que en el bot)
        const targetCup = parseFloat(targetUser.cup) || 0;
        const targetUsd = parseFloat(targetUser.usd) || 0;
        const targetBonusCup = parseFloat(targetUser.bonus_cup) || 0;

        let updatedTargetCup = targetCup;
        let updatedTargetUsd = targetUsd;
        let bonusMovedCup = 0;

        if (currency === 'CUP') {
            updatedTargetCup += parsedAmount;
        } else if (currency === 'USD') {
            updatedTargetUsd += parsedAmount;
        } else {
            updatedTargetCup += debitPlan.amountCUP;
        }

        if (targetBonusCup > 0) {
            updatedTargetCup += targetBonusCup;
            bonusMovedCup = targetBonusCup;
        }

        const targetUpdatePayload = {
            cup: updatedTargetCup,
            usd: updatedTargetUsd,
            updated_at: new Date()
        };
        if (bonusMovedCup > 0) targetUpdatePayload.bonus_cup = 0;

        await supabase
            .from('users')
            .update(targetUpdatePayload)
            .eq('telegram_id', targetUserId);
}

async function setExchangeRateMLC(rate) {
    const { error } = await supabase
        .from('exchange_rate')
        .update({ rate_mlc: rate, updated_at: new Date() })
        .eq('id', 1);

    if (error) {
        return { ok: false, error };
    }

    return { ok: true };
}

// Convertir cualquier moneda a CUP
async function convertToCUP(amount, currency) {
    const rates = await getExchangeRates();
    switch (currency) {
        case 'CUP': return amount;
        case 'USD': return amount * rates.rate;
        case 'USDT': return amount * rates.rate_usdt;
        case 'TRX': return amount * rates.rate_trx;
        case 'MLC': return amount * rates.rate_mlc;
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
        case 'MLC': return amountCUP / rates.rate_mlc;
        default: return 0;
    }
}

async function buildCrossCurrencyDebitPlan(user, amount, currency) {
    const cupBalance = parseFloat(user?.cup) || 0;
    const usdBalance = parseFloat(user?.usd) || 0;
    const rateUSD = await getExchangeRateUSD();
    const amountCUP = await convertToCUP(amount, currency);
    const totalAvailableCUP = cupBalance + (usdBalance * rateUSD);

    if (amountCUP <= 0 || totalAvailableCUP < amountCUP) {
        return {
            ok: false,
            amountCUP,
            totalAvailableCUP,
            cupBalance,
            usdBalance,
            rateUSD,
            cupDebit: 0,
            usdDebit: 0
        };
    }

    const cupDebit = Math.min(cupBalance, amountCUP);
    const remainingCup = amountCUP - cupDebit;
    const usdDebit = remainingCup > 0 ? (remainingCup / rateUSD) : 0;

    return {
        ok: true,
        amountCUP,
        totalAvailableCUP,
        cupBalance,
        usdBalance,
        rateUSD,
        cupDebit,
        usdDebit
    };
}

async function buildRealBalanceDebitPlan(user, amount, currency) {
    const cupBalance = parseFloat(user?.cup) || 0;
    const usdBalance = parseFloat(user?.usd) || 0;
    const rateUSD = await getExchangeRateUSD();
    const parsedAmount = parseFloat(amount) || 0;

    if (currency === 'USD') {
        if (parsedAmount <= 0 || usdBalance < parsedAmount) {
            return {
                ok: false,
                amountCUP: parsedAmount * rateUSD,
                totalAvailableCUP: cupBalance + (usdBalance * rateUSD),
                cupBalance,
                usdBalance,
                rateUSD,
                cupDebit: 0,
                usdDebit: 0,
                errorMessage: `Saldo USD insuficiente. Por favor, recarga.`
            };
        }

        return {
            ok: true,
            amountCUP: parsedAmount * rateUSD,
            totalAvailableCUP: cupBalance + (usdBalance * rateUSD),
            cupBalance,
            usdBalance,
            rateUSD,
            cupDebit: 0,
            usdDebit: parsedAmount
        };
    }

    return buildCrossCurrencyDebitPlan(user, parsedAmount, currency);
}

// ========== FUNCIÓN GETORCREATEUSER CON MANEJO DE ERROR DE COLUMNA ==========
async function getOrCreateUser(telegramId, firstName = 'Jugador', username = null) {
    try {
        let isNewUser = false;
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
                isNewUser = true;
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
        // Migrar el bono al saldo principal solo si el usuario ya tuvo al menos
        // un depósito aprobado.
        try {
            const cupAmt = parseFloat(user.cup) || 0;
            const bonusAmt = parseFloat(user.bonus_cup) || 0;
            const hasApprovedDeposit = await userHasApprovedDeposit(telegramId);
            if (hasApprovedDeposit && bonusAmt > 0) {
                const newCup = cupAmt + bonusAmt;
                await supabase.from('users').update({ cup: newCup, bonus_cup: 0, updated_at: new Date() }).eq('telegram_id', telegramId);
                user.cup = newCup;
                user.bonus_cup = 0;
            }
        } catch (e) {
            console.error('Error migrando bono por saldo existente:', e);
        }

        if (user && typeof user === 'object') {
            user.__isNewUser = isNewUser;
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

function expandDTNumbers(token, betType) {
    const match = String(token || '').trim().toUpperCase().match(/^([DT])(\d)$/);
    if (!match) return [];

    const prefix = match[1];
    const digit = match[2];

    if (betType === 'fijo') {
        const out = [];
        for (let i = 0; i <= 9; i++) {
            out.push(prefix === 'D' ? `${digit}${i}` : `${i}${digit}`);
        }
        return out;
    }

    if (betType === 'centena') {
        const out = [];
        for (let i = 0; i <= 99; i++) {
            const twoDigits = String(i).padStart(2, '0');
            out.push(prefix === 'D' ? `${digit}${twoDigits}` : `${twoDigits}${digit}`);
        }
        return out;
    }

    return [];
}

// ========== FUNCIONES DE PARSEO DE APUESTAS ==========
function parseBetLine(line, betType) {
    line = line.trim().toLowerCase();
    if (!line) return [];

    const match = line.match(/^([\d\s,xtd]+)\s*(?:con|\*)\s*([0-9.]+)\s*(usd|cup|usdt|trx|mlc)$/i);
    if (!match) return [];

    let numerosStr = match[1].trim();
    const montoStr = match[2];
    const moneda = match[3].toUpperCase();

    let numeros = [];
    // Soportar 'parle' en formato '17x32' o '17 x 32'
    if (betType === 'parle') {
        const pairs = Array.from(numerosStr.matchAll(/(\d{2})\s*x\s*(\d{2})/gi));
        if (pairs.length) {
            numeros = pairs.map(p => `${p[1]}x${p[2]}`);
        } else {
            numeros = numerosStr.split(/[\s,]+/).filter(n => n.length > 0);
        }
    } else {
        numeros = numerosStr.split(/[\s,]+/).filter(n => n.length > 0);
    }
    const montoBase = parseFloat(montoStr);
    if (isNaN(montoBase) || montoBase <= 0) return [];

    const resultados = [];

    for (let numero of numeros) {
        const expanded = expandDTNumbers(numero, betType);
        if (expanded.length > 0) {
            for (const expandedNumber of expanded) {
                resultados.push({
                    numero: expandedNumber,
                    currency: moneda,
                    amount: montoBase
                });
            }
            continue;
        }

        if (betType === 'fijo') {
            if (!/^\d{2}$/.test(numero)) {
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
            numero,
            currency: moneda,
            amount: montoBase
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

    const deliveryErrorsToIgnore = [
        'chat not found',
        'bot was blocked by the user',
        'user is deactivated',
        'forbidden: bot was blocked by the user'
    ];

    let sentCount = 0;
    let inactiveCount = 0;
    let failedCount = 0;

    for (const u of users || []) {
        try {
            await bot.telegram.sendMessage(u.telegram_id, message, { parse_mode: parseMode });
            sentCount += 1;
            await new Promise(resolve => setTimeout(resolve, 30));
        } catch (e) {
            const errorMessage = (e?.message || '').toLowerCase();
            const isInactiveUser = deliveryErrorsToIgnore.some(fragment => errorMessage.includes(fragment));

            if (isInactiveUser) {
                inactiveCount += 1;
                continue;
            }

            failedCount += 1;
            console.warn(`Error enviando broadcast a ${u.telegram_id}:`, e.message);
        }
    }

    console.log(`[Broadcast] Enviado: ${sentCount} · Inactivos: ${inactiveCount} · Fallidos: ${failedCount}`);
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
    const isNewUser = !!user?.__isNewUser;
    if (user && typeof user === 'object' && '__isNewUser' in user) {
        delete user.__isNewUser;
    }
    const rates = await getExchangeRates();

    const botInfo = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)
        .then(r => r.data.result)
        .catch(() => ({ username: '4pu3$t4$_QvaBot' }));

    res.json({
        user,
        isNewUser,
        isAdmin: isAdmin(tgUser.id),
        exchangeRate: rates.rate,
        exchangeRateMLC: rates.rate_mlc,
        exchangeRateUSDT: rates.rate_usdt,
        exchangeRateTRX: rates.rate_trx,
        botUsername: botInfo.username,
        bonusCupDefault: BONUS_CUP_DEFAULT
    });
});

// --- Métodos de depósito ---
app.get('/api/deposit-methods', async (req, res) => {
    const { data } = await supabase.from('deposit_methods').select('*').order('id');
    // Forzar min_amount y max_amount a número si existen
    const fixed = (data || []).map(m => ({
        ...m,
        min_amount: m.min_amount !== null && m.min_amount !== undefined ? Number(m.min_amount) : null,
        max_amount: m.max_amount !== null && m.max_amount !== undefined ? Number(m.max_amount) : null
    }));
    res.json(fixed);
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
    const { lottery, date: dateParam, time_slot } = req.query;
    if (!lottery) {
        return res.status(400).json({ error: 'Falta parámetro lottery' });
    }
    // Usar la fecha del servidor (zona horaria configurada) si el cliente no proporciona una
    const date = dateParam || moment.tz(TIMEZONE).format('YYYY-MM-DD');

    // Si se proporciona time_slot, buscar sesión abierta específica
    if (time_slot) {
        const { data } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('lottery', lottery)
            .eq('date', date)
            .eq('time_slot', time_slot)
            .eq('status', 'open')
            .maybeSingle();
        return res.json(data);
    }

    // Si no se proporciona time_slot, devolver cualquier sesión abierta para la lotería en la fecha
    const { data: anyOpen } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('lottery', lottery)
        .eq('date', date)
        .eq('status', 'open')
        .limit(1)
        .maybeSingle();
    return res.json(anyOpen);
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

    // Regla: USD solo se retira desde saldo USD.
    // Otras monedas sí pueden usar saldo combinado CUP + USD.
    const debitPlan = await buildRealBalanceDebitPlan(user, parseFloat(amount), currency);
    if (!debitPlan.ok) {
        return res.status(400).json({
            error: debitPlan.errorMessage || `Saldo real insuficiente. Disponible: ${debitPlan.totalAvailableCUP.toFixed(2)} CUP, necesitas ${debitPlan.amountCUP.toFixed(2)} CUP.`
        });
    }

    if (method.min_amount !== null && amount < method.min_amount) {
        return res.status(400).json({ error: `Monto mínimo: ${method.min_amount} ${currency}` });
    }
    if (method.max_amount !== null && amount > method.max_amount) {
        return res.status(400).json({ error: `Monto máximo: ${method.max_amount} ${currency}` });
    }

    // Calcular amount_usd igual que en el bot
    let amount_usd = null;
    if (currency === 'USD') {
        amount_usd = parseFloat(amount);
    } else if (currency === 'CUP') {
        // Obtener tasa USD
        const { data: rateData } = await supabase
            .from('exchange_rate')
            .select('rate_usd')
            .single();
        const rate = rateData?.rate_usd || 1;
        amount_usd = parseFloat(amount) / rate;
    } else if (currency === 'USDT' || currency === 'TRX' || currency === 'MLC') {
        amount_usd = parseFloat(amount); // Asumimos 1:1
    }

    const { data: request, error: insertError } = await supabase
        .from('withdraw_requests')
        .insert({
            user_id: parseInt(userId),
            method_id: parseInt(methodId),
            amount,
            currency,
            account_info: accountInfo,
            status: 'pending',
            amount_usd
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
        return res.status(400).json({ error: 'Moneda no soportada. Usa CUP o USD' });
    }

    const parsedAmount = parseFloat(amount);

    // Intentar obtener el mínimo desde el método de depósito más reciente
    let minByCurrency = null;
    try {
        const { data: allMethods } = await supabase
            .from('deposit_methods')
            .select('*')
            .order('id', { ascending: true });
        const methods = (allMethods || []).filter(m => ((m.currency || '').toString().trim().toUpperCase()) === currency);
        if (methods && methods.length > 0) {
            const method = methods.reduce((a, b) => (a.id > b.id ? a : b));
            if (method && method.min_amount !== null && method.min_amount !== undefined) {
                minByCurrency = parseFloat(method.min_amount);
            }
        }
    } catch (e) {
        console.error('Error obteniendo métodos de depósito para mínimo de transferencia:', e);
    }

    // Fallback: regla antigua (1 USD)
    if (minByCurrency === null) {
        const transferMinUSD = 1;
        const transferMinCUP = await convertToCUP(transferMinUSD, 'USD');
        minByCurrency = currency === 'USD' ? transferMinUSD : transferMinCUP;
    }

    if (parsedAmount < minByCurrency) {
        return res.status(400).json({ error: `El monto mínimo para transferir en ${currency} es ${minByCurrency.toFixed(2)} ${currency}.` });
    }

    if (from === to) {
        return res.status(400).json({ error: 'No puedes transferirte a ti mismo\nPor favor, vuelve a iniciar la operación' });
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

    // Regla: USD solo se transfiere desde saldo USD.
    // Otras monedas sí pueden usar saldo combinado CUP + USD.
    const debitPlan = await buildRealBalanceDebitPlan(userFrom, parsedAmount, currency);
    if (!debitPlan.ok) {
        return res.status(400).json({
            error: debitPlan.errorMessage || `Saldo real insuficiente. Disponible: ${debitPlan.totalAvailableCUP.toFixed(2)} CUP, necesitas ${debitPlan.amountCUP.toFixed(2)} CUP.`
        });
    }

    // Debitar origen
    await supabase
        .from('users')
        .update({
            cup: (parseFloat(userFrom.cup) || 0) - debitPlan.cupDebit,
            usd: (parseFloat(userFrom.usd) || 0) - debitPlan.usdDebit,
            updated_at: new Date()
        })
        .eq('telegram_id', from);

    // Acreditar destino y migrar bono si existe (comportamiento igual al bot)
    const targetCup = parseFloat(targetUser.cup) || 0;
    const targetUsd = parseFloat(targetUser.usd) || 0;
    const targetBonusCup = parseFloat(targetUser.bonus_cup) || 0;

    let updatedTargetCup = targetCup;
    let updatedTargetUsd = targetUsd;
    let bonusMovedCup = 0;

    if (currency === 'CUP') {
        updatedTargetCup += parsedAmount;
    } else if (currency === 'USD') {
        updatedTargetUsd += parsedAmount;
    } else {
        updatedTargetCup += debitPlan.amountCUP;
    }

    // Mover bono SOLO si el usuario no tenía saldo principal y no tuvo depósitos aprobados antes
    try {
        const hadNoMainBalance = (targetCup === 0 && targetUsd === 0);
        const hadApprovedDeposit = await userHasApprovedDeposit(targetUserId);
        if (targetBonusCup > 0 && hadNoMainBalance && !hadApprovedDeposit) {
            updatedTargetCup += targetBonusCup;
            bonusMovedCup = targetBonusCup;
        }
    } catch (e) {
        // En caso de error al verificar depósitos aprobados, no mover el bono por seguridad
        console.warn('Error verificando depósitos aprobados para migrar bono:', e?.message || e);
    }

    const targetUpdatePayload = {
        cup: updatedTargetCup,
        usd: updatedTargetUsd,
        updated_at: new Date()
    };
    if (bonusMovedCup > 0) targetUpdatePayload.bonus_cup = 0;

    await supabase
        .from('users')
        .update(targetUpdatePayload)
        .eq('telegram_id', targetUserId);

    // Intentar notificar al usuario destino vía bot (si está cargado)
    try {
        const fromName = (userFrom && (userFrom.first_name || userFrom.username)) ? (userFrom.first_name || userFrom.username) : String(from);
        let message = `🔄 <b>Has recibido una transferencia</b>\n\n` +
            `👤 De: ${escapeHtml(fromName)}\n` +
            `💰 Monto: ${parsedAmount} ${currency}\n`;
        if (currency === 'USD') {
            message += `ℹ️Con tu saldo USD también puedes transferir en CUP; además retirar en CUP, USDT, TRX o MLC según los métodos disponibles.\n`;
        }
        if (bonusMovedCup > 0) {
            message += `🎁 Tu bono de bienvenida de ${bonusMovedCup.toFixed(2)} CUP se ha movido a tu saldo principal.\n`;
        }
        message += `📊 Saldo actualizado.`;

        if (bot && bot.telegram && typeof bot.telegram.sendMessage === 'function') {
            await bot.telegram.sendMessage(targetUserId, message, { parse_mode: 'HTML' });
        } else {
            // Fallback: intentar llamar la API de Telegram directamente si BOT_TOKEN está disponible
            if (BOT_TOKEN) {
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: targetUserId,
                    text: message,
                    parse_mode: 'HTML'
                }).catch(() => {});
            }
        }
    } catch (e) {
        console.warn('No se pudo enviar notificación de transferencia via bot:', e?.message || e);
    }

    res.json({ success: true, bonusMovedCup: bonusMovedCup, creditedCupEquivalent: currency === 'CUP' || currency === 'USD' ? null : debitPlan.amountCUP });
});

// --- Registro de apuestas ---
app.post('/api/bets', async (req, res) => {
    const { userId, lottery, betType, rawText, sessionId, betId } = req.body;
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
        // soportar dos formatos: {currency, amount} (backend) y {usd,cup} (frontend)
        const itCup = item.cup !== undefined ? parseFloat(item.cup) : (item.currency === 'CUP' ? parseFloat(item.amount) : 0);
        const itUsd = item.usd !== undefined ? parseFloat(item.usd) : (item.currency === 'USD' ? parseFloat(item.amount) : 0);

        if (itCup > 0) {
            if (itCup < minCup) return res.status(400).json({ error: `❌ Mínimo en CUP: ${parseFloat(minCup).toFixed(2)}` });
            if (maxCup !== null && itCup > maxCup) return res.status(400).json({ error: `❌ Máximo en CUP: ${parseFloat(maxCup).toFixed(2)}` });
        }
        if (itUsd > 0) {
            if (itUsd < minUsd) return res.status(400).json({ error: `❌ Mínimo en USD: ${parseFloat(minUsd).toFixed(2)}` });
            if (maxUsd !== null && itUsd > maxUsd) return res.status(400).json({ error: `❌ Máximo en USD: ${parseFloat(maxUsd).toFixed(2)}` });
        }
    }

    // Verificación temprana: asegurar que si la apuesta incluye CUP, el usuario
    // tenga suficiente suma de `cup + bonus_cup` para cubrir el totalCUP.
    const userCup = parseFloat(user.cup) || 0;
    const userBonusCup = parseFloat(user.bonus_cup) || 0;
    const availableCupNow = userCup + userBonusCup;
    if (totalCUP > 0 && availableCupNow < totalCUP) {
        return res.status(400).json({ error: 'Saldo CUP insuficiente. Por favor, recarga', debug: { userCup, userBonusCup, availableCupNow, totalCUP, parsed } });
    }

    // Helper para parsear floats seguros
    const safe = v => isNaN(parseFloat(v)) ? 0 : parseFloat(v);

    // Si se proporciona betId -> actualizar apuesta existente (reembolso + aplicar nueva)
    if (betId) {
        const { data: existingBet } = await supabase.from('bets').select('*').eq('id', betId).maybeSingle();
        if (!existingBet) return res.status(404).json({ error: 'Jugada no encontrada' });
        if (parseInt(existingBet.user_id) !== parseInt(userId)) return res.status(403).json({ error: 'No autorizado para editar esta jugada' });

        if (existingBet.session_id) {
            const { data: session } = await supabase.from('lottery_sessions').select('status').eq('id', existingBet.session_id).maybeSingle();
            if (!session || session.status !== 'open') return res.status(400).json({ error: 'No se puede editar: sesión cerrada' });
        }

        // Reembolsar montos anteriores
        const oldUsd = safe(existingBet.cost_usd);
        const oldCup = safe(existingBet.cost_cup);
        const { data: uBefore } = await supabase.from('users').select('usd,cup,bonus_cup').eq('telegram_id', userId).single();
        let refundUsd = safe(uBefore.usd) + oldUsd;
        let refundCup = safe(uBefore.cup) + oldCup;

        await supabase.from('users').update({ usd: refundUsd, cup: refundCup, updated_at: new Date() }).eq('telegram_id', userId);

        // Recargar usuario y volver a intentar descontar para nueva apuesta
        const userAfterRefund = await getOrCreateUser(parseInt(userId));
        let newUsd = safe(userAfterRefund.usd);
        let newBonus = safe(userAfterRefund.bonus_cup);
        let newCup = safe(userAfterRefund.cup);

        if (totalUSD > 0) {
            if (newUsd < totalUSD) return res.status(400).json({ error: 'Saldo USD insuficiente para la edición. Por favor. racarga' });
            newUsd -= totalUSD;
        }

        if (totalCUP > 0) {
            // Permitir usar bono en CUP además del saldo CUP
            const availableCupTotal = newCup + newBonus;
            if (availableCupTotal < totalCUP) return res.status(400).json({ error: 'Saldo CUP insuficiente para la edición. Por favor, recarga' });
            if (newCup >= totalCUP) {
                newCup -= totalCUP;
            } else {
                const deficit = totalCUP - newCup;
                newBonus = Math.max(0, newBonus - deficit);
                newCup = 0;
            }
        }

        await supabase.from('users').update({ usd: newUsd, bonus_cup: newBonus, cup: newCup, updated_at: new Date() }).eq('telegram_id', userId);

        const { data: updatedBet, error: updateError } = await supabase.from('bets').update({ raw_text: rawText, items: parsed.items, cost_usd: totalUSD, cost_cup: totalCUP, updated_at: new Date() }).eq('id', betId).select().single();
        if (updateError) {
            console.error('Error actualizando apuesta:', updateError);
            return res.status(500).json({ error: 'Error al actualizar la apuesta' });
        }

        const updatedUser = await getOrCreateUser(parseInt(userId));
        return res.json({ success: true, bet: updatedBet, updatedUser });
    }

    // Flujo normal: crear nueva apuesta y guardar cost_usd/cost_cup
    let newUsd = safe(user.usd);
    let newBonus = safe(user.bonus_cup);
    let newCup = safe(user.cup);

    if (totalUSD > 0) {
        if (newUsd < totalUSD) return res.status(400).json({ error: 'Saldo USD insuficiente. Por favor, recarga.' });
        newUsd -= totalUSD;
    }

    if (totalCUP > 0) {
        // Permitir usar bono en CUP además del saldo CUP
        const availableCupTotal = newCup + newBonus;
        if (availableCupTotal < totalCUP) return res.status(400).json({ error: 'Saldo CUP insuficiente. Por favor, recarga' });
        if (newCup >= totalCUP) {
            newCup -= totalCUP;
        } else {
            const deficit = totalCUP - newCup;
            newBonus = Math.max(0, newBonus - deficit);
            newCup = 0;
        }
    }

    await supabase.from('users').update({ usd: newUsd, bonus_cup: newBonus, cup: newCup, updated_at: new Date() }).eq('telegram_id', userId);

    const { data: bet, error: betError } = await supabase.from('bets').insert({ user_id: parseInt(userId), lottery, session_id: sessionId || null, bet_type: betType, raw_text: rawText, items: parsed.items, cost_usd: totalUSD, cost_cup: totalCUP, placed_at: new Date() }).select().single();
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
    let bonusMovedCup = 0;

    const hasApprovedDeposit = await userHasApprovedDeposit(parseInt(userId));
    const usdRate = hasApprovedDeposit ? 0 : await getExchangeRateUSD();

    for (const item of bet.items) {
        const amount = parseFloat(item.amount) || 0;
        if (item.currency === 'CUP') {
            if (hasApprovedDeposit) newCup += amount;
            else newBonus += amount;
        } else if (item.currency === 'USD') {
            if (hasApprovedDeposit) newUsd += amount;
            else newBonus += amount * usdRate;
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

app.put('/api/admin/exchange-rate/mlc', requireAdmin, async (req, res) => {
    const { rate } = req.body;
    if (!rate || rate <= 0) return res.status(400).json({ error: 'Tasa inválida' });
    const result = await setExchangeRateMLC(rate);
    if (!result.ok) {
        return res.status(500).json({
            error: 'No se pudo actualizar la tasa MLC. Verifica que exista la columna rate_mlc en exchange_rate.'
        });
    }
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
                    if (numero.startsWith('D')) {
                        const digito = numero[1];
                        if (centena.startsWith(digito)) ganado = true;
                    } else if (numero.startsWith('T')) {
                        const digito = numero[1];
                        if (centena.endsWith(digito)) ganado = true;
                    } else {
                        if (numero === centena) ganado = true;
                    }
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
                    if (numero.startsWith('D')) {
                        const digito = numero[1];
                        if (centena.startsWith(digito)) ganado = true;
                    } else if (numero.startsWith('T')) {
                        const digito = numero[1];
                        if (centena.endsWith(digito)) ganado = true;
                    } else {
                        if (numero === centena) ganado = true;
                    }
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
    let bonusMovedCup = 0;

    // Convertir el monto a CUP si es necesario (los depósitos siempre incrementan CUP o USD según la moneda)
    if (request.currency === 'CUP') {
        newCup += parseFloat(request.amount);
    } else if (request.currency === 'USD') {
        // Solo USD acredita la columna USD
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

    const { data: prevApproved } = await supabase
        .from('deposit_requests')
        .select('id')
        .eq('user_id', request.user_id)
        .eq('status', 'approved')
        .neq('id', parseInt(id))
        .limit(1);

    const isFirstDeposit = !(prevApproved && prevApproved.length > 0);

    if (isFirstDeposit && newBonus > 0) {
        newCup += newBonus;
        bonusMovedCup = newBonus;
        await supabase
            .from('users')
            .update({ cup: newCup, bonus_cup: 0, updated_at: new Date() })
            .eq('telegram_id', request.user_id);
    }

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
        const creditedAmount = request.currency === 'USD'
            ? parseFloat(request.amount)
            : await convertToCUP(parseFloat(request.amount), request.currency);

        const depositedAmountText = request.amount && /[a-zA-Z]/.test(String(request.amount))
            ? String(request.amount)
            : `${request.amount} ${String(request.currency || '').toLowerCase()}`;

        let text =
            `✅ <b>Depósito aprobado</b>\n\n` +
            `💰 Monto depositado: ${depositedAmountText}\n` +
            `💵 Se acreditaron ${creditedAmount.toFixed(2)} ${request.currency === 'USD' ? 'USD' : 'CUP'} a tu saldo ${request.currency === 'USD' ? 'USD' : 'CUP'}.\n`;

        if (request.currency === 'USD') {
            text += `ℹ️Con tu saldo USD también puedes transferir en CUP; además retirar en CUP, USDT, TRX o MLC según los métodos disponibles.\n`;
        }

        if (bonusMovedCup > 0) {
            text += `🎁 Tu bono de bienvenida de ${bonusMovedCup.toFixed(2)} CUP se ha movido a tu saldo principal.\n`;
        } else if (isFirstDeposit) {
            text += `🎁 Tu bono de bienvenida se ha movido a tu saldo principal.\n`;
        }

        text += `\n¡Gracias por confiar en nosotros!`;

        await bot.telegram.sendMessage(request.user_id,
            text,
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
        await bot.telegram.sendMessage(
            request.user_id,
            `❌ Depósito rechazado\n\n📌La solicitud no pudo ser procesada. Por favor, contáctanos si crees que esto es un error.`,
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
    const debitPlan = await buildRealBalanceDebitPlan(user, parseFloat(request.amount), request.currency);
    if (!debitPlan.ok) {
        return res.status(400).json({ error: debitPlan.errorMessage || 'Saldo insuficiente (posible cambio de tasa). Rechace la solicitud.' });
    }

    let newCup = (parseFloat(user.cup) || 0) - debitPlan.cupDebit;
    let newUsd = (parseFloat(user.usd) || 0) - debitPlan.usdDebit;

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
            `📌 En breve los fondos serán enviados a tu cuenta.`,
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

// Import and launch bot asynchronously to support ESM modules with top-level await
// Load bot via require (CommonJS) and launch it. Use promise handlers
// instead of top-level await/import to avoid ambiguous module format errors
try {
    const required = require('./bot.js');
    bot = required.default || required;

    if (bot && typeof bot.launch === 'function') {
        let launchAttempts = 0;
        let launchInProgress = false;
        let botStarted = false;

        const launchBotWithRetry = () => {
            if (botStarted || launchInProgress) return;

            launchInProgress = true;
            launchAttempts += 1;

            bot.telegram.deleteWebhook()
                .catch(() => {})
                .finally(() => {
                    bot.launch()
                        .then(() => {
                            botStarted = true;
                            launchInProgress = false;
                            console.log('🤖 Bot de Telegram iniciado correctamente (polling, webhook desactivado)');
                        })
                        .catch(err => {
                            launchInProgress = false;
                            const canRetry = BOT_LAUNCH_MAX_RETRIES === 0 || launchAttempts < BOT_LAUNCH_MAX_RETRIES;
                            const retryDelay = Math.min(BOT_LAUNCH_RETRY_BASE_MS * Math.pow(2, launchAttempts - 1), BOT_LAUNCH_RETRY_MAX_MS);
                            const errorCode = err?.code || err?.errno || 'UNKNOWN';

                            console.error(`❌ Error al iniciar el bot (intento ${launchAttempts}, código ${errorCode}):`, err?.message || err);

                            if (canRetry) {
                                console.log(`🔁 Reintentando iniciar bot en ${Math.round(retryDelay / 1000)}s...`);
                                setTimeout(launchBotWithRetry, retryDelay);
                            } else {
                                console.error('⛔ Se alcanzó el máximo de reintentos para iniciar el bot.');
                            }
                        });
                });
        };

        launchBotWithRetry();

        process.once('SIGINT', () => bot.stop('SIGINT'));
        process.once('SIGTERM', () => bot.stop('SIGTERM'));
    } else {
        console.warn('⚠️ Bot cargado pero no tiene método launch()');
    }
} catch (err) {
    console.error('❌ Error cargando bot.js con require():', err);
}

module.exports = app;
