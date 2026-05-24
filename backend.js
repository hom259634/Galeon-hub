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
let bot; 
let botInfo = { username: 'bot', first_name: 'Bot' };

// ======== == CONFIGURACIÓN DESDE .ENV ==========
const SECURITY = process.env.AUTH;
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BONUS_CUP_DEFAULT = parseFloat(process.env.BONUS_CUP_DEFAULT) || 0;
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
    return ADMIN_IDS.includes(Number(userId));
}

// ========== SISTEMA DE ROLES ADMINISTRATIVOS ==========
let rolesCache = { depositApprovers: [], withdrawApprovers: [], scheduleManagers: [], userManagers: [], lastFetch: 0 };
const ROLES_CACHE_TTL = 60000;

async function refreshRolesCache() {
    try {
        const { data } = await supabase.from('admin_roles').select('telegram_id, role');
        rolesCache.depositApprovers = data?.filter(r => r.role === 'deposit_approver').map(r => Number(r.telegram_id)) || [];
        rolesCache.withdrawApprovers = data?.filter(r => r.role === 'withdraw_approver').map(r => Number(r.telegram_id)) || [];
        rolesCache.scheduleManagers = data?.filter(r => r.role === 'schedule_manager').map(r => Number(r.telegram_id)) || [];
        rolesCache.userManagers = data?.filter(r => r.role === 'user_manager').map(r => Number(r.telegram_id)) || [];
        rolesCache.lastFetch = Date.now();
    } catch (e) {
        console.error('Error refreshing roles cache:', e);
    }
}

async function ensureRolesCache() {
    if (Date.now() - rolesCache.lastFetch > ROLES_CACHE_TTL) await refreshRolesCache();
}

async function getUserRoles(userId) {
    await ensureRolesCache();
    const id = Number(userId);
    const roles = [];
    if (rolesCache.depositApprovers.includes(id)) roles.push('deposit_approver');
    if (rolesCache.withdrawApprovers.includes(id)) roles.push('withdraw_approver');
    if (rolesCache.scheduleManagers.includes(id)) roles.push('schedule_manager');
    if (rolesCache.userManagers.includes(id)) roles.push('user_manager');
    return roles;
}

async function hasRole(userId, role) {
    await ensureRolesCache();
    const id = Number(userId);
    if (isAdmin(userId)) return true; // super admins have all roles
    switch (role) {
        case 'withdraw_approver': return rolesCache.withdrawApprovers.includes(id);
        case 'deposit_approver': return rolesCache.depositApprovers.includes(id);
        case 'schedule_manager': return rolesCache.scheduleManagers.includes(id);
        case 'user_manager': return rolesCache.userManagers.includes(id);
        default: return false;
    }
}

async function hasAnyRole(userId) {
    if (isAdmin(userId)) return true;
    const roles = await getUserRoles(userId);
    return roles.length > 0;
}

async function requireAdminOrRole(req, res, next, allowedRoles = []) {
    let userId = req.verifiedTelegramId || req.body.userId || req.query.userId || req.headers['x-telegram-id'];
    if (!userId) return res.status(403).json({ error: 'No autorizado: falta userId' });
    if (isAdmin(userId)) return next();
    for (const role of allowedRoles) {
        if (await hasRole(userId, role)) return next();
    }
    return res.status(403).json({ error: 'No tienes permisos para esta acción' });
}

// ========== SEGUIMIENTO DE NOTIFICACIONES (para reflejar decisiones web ↔ bot) ==========
const pendingNotifications = new Map(); // key: "deposit_{id}" o "withdraw_{id}" -> [{chatId, messageId}]

async function updatePendingNotifications(key, statusText) {
    const entries = pendingNotifications.get(key);
    if (!entries) return;
    for (const { chatId, messageId } of entries) {
        try {
            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
                chat_id: chatId,
                message_id: messageId,
                text: statusText,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [] }
            });
        } catch (e) {}
    }
    pendingNotifications.delete(key);
}

// Almacén de idempotencia para transferencias (evita doble proceso)
const transferIdempotencyStore = new Map();
const IDEMPOTENCY_TTL = 5 * 60 * 1000; // 5 minutos
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of transferIdempotencyStore) {
        if (now - entry.timestamp > IDEMPOTENCY_TTL) transferIdempotencyStore.delete(key);
    }
}, 60 * 1000);

// Precargar caché al inicio
refreshRolesCache();

function formatHour12(hourDecimal) {
    const totalMinutes = Math.round(hourDecimal * 60);
    const h = Math.floor(totalMinutes / 60) % 12 || 12;
    const m = totalMinutes % 60;
    const ampm = totalMinutes < 720 ? 'AM' : 'PM';
    return `${h}:${m.toString().padStart(2, '0')} ${ampm}`;
}

function formatHourDecimal(hourDecimal) {
    const h = Math.floor(hourDecimal);
    const m = Math.round((hourDecimal - h) * 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`;
}

async function isWithdrawTime() {
    // El horario programado siempre es la prioridad
    const start = await getWithdrawTimeStart();
    const end = await getWithdrawTimeEnd();
    const now = moment.tz(TIMEZONE);
    const currentHour = now.hour() + now.minute() / 60;

    // Si estamos dentro del horario → abierto, siempre (sin importar override)
    if (currentHour >= start && currentHour < end) return true;

    // Fuera del horario → solo si hay un override manual 'open'
    const { data: overrideData } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'withdraw_manual_override')
        .single();
    const override = overrideData?.value || 'none';

    return override === 'open';
}

async function getReferralCommissionRate() {
    const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'referral_commission_rate')
        .single();
    return data ? parseFloat(data.value) : 0;
}

async function getBonusCupDefault() {
    const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'bonus_cup_default')
        .single();
    return data ? parseFloat(data.value) : 0;
}

function escapeHTML(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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
        .from('exchange_rate')
        .update({ rate, updated_at: new Date() })
        .eq('id', 1);
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
                errorMessage: `❌ Saldo USD insuficiente. Por favor, recarga.`
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
                const currentBonusDefault = await getBonusCupDefault();
                const { data: newUser, error: insertError } = await supabase
                    .from('users')
                    .insert({
                        telegram_id: telegramId,
                        first_name: firstName,
                        username: username,
                        bonus_cup: currentBonusDefault,
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
        
        // Migrar bono automáticamente si alcanza el mínimo de depósito en CUP
        try {
            const cupAmt2 = parseFloat(user.cup) || 0;
            const bonusAmt2 = parseFloat(user.bonus_cup) || 0;
            if (bonusAmt2 > 0) {
                const minDepCUP = await getMinDepositCUP();
                if (bonusAmt2 >= minDepCUP) {
                    const newCup2 = cupAmt2 + bonusAmt2;
                    await supabase.from('users').update({
                        cup: newCup2,
                        bonus_cup: 0,
                        updated_at: new Date()
                    }).eq('telegram_id', telegramId);
                    user.cup = newCup2;
                    user.bonus_cup = 0;
                }
            }
        } catch (e) {
            console.error('Error migrando bono por umbral mínimo:', e);
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

async function getWithdrawTimeStart() {
    const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'withdraw_time_start')
        .single();
    return data ? parseFloat(data.value) : 22;
}

async function getWithdrawTimeEnd() {
    const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'withdraw_time_end')
        .single();
    return data ? parseFloat(data.value) : 23.5;
}

async function getManualOverrideExpiry() {
    const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'withdraw_manual_override_expiry')
        .single();
    return data ? new Date(data.value) : null;
}

async function setManualOverrideExpiry(date) {
    await supabase
        .from('app_config')
        .upsert({ key: 'withdraw_manual_override_expiry', value: date.toISOString() }, { onConflict: 'key' });
}

async function clearManualOverrideExpiry() {
    await supabase
        .from('app_config')
        .upsert({ key: 'withdraw_manual_override_expiry', value: null }, { onConflict: 'key' });
}

// ---------- Mínimos de transferencia personalizables ----------
async function getTransferMinCUP() {
    try {
        const { data } = await supabase
            .from('app_config')
            .select('value')
            .eq('key', 'transfer_min_cup')
            .single();
        return data ? parseFloat(data.value) : null;
    } catch (e) {
        return null;
    }
}

async function getTransferMinUSD() {
    try {
        const { data } = await supabase
            .from('app_config')
            .select('value')
            .eq('key', 'transfer_min_usd')
            .single();
        return data ? parseFloat(data.value) : null;
    } catch (e) {
        return null;
    }
}

// Guardar ambos valores a la vez
async function setTransferMins(minCup, minUsd) {
    if (minCup !== undefined) {
        await supabase
            .from('app_config')
            .upsert({ key: 'transfer_min_cup', value: minCup.toString() }, { onConflict: 'key' });
    }
    if (minUsd !== undefined) {
        await supabase
            .from('app_config')
            .upsert({ key: 'transfer_min_usd', value: minUsd.toString() }, { onConflict: 'key' });
    }
}

async function getMinDepositCUP() {
    try {
        const { data } = await supabase
            .from('deposit_methods')
            .select('min_amount')
            .eq('currency', 'CUP')
            .not('min_amount', 'is', null)
            .order('min_amount', { ascending: true })
            .limit(1);
        if (data && data.length > 0 && data[0].min_amount !== null) {
            return parseFloat(data[0].min_amount);
        }
    } catch (e) {}
    return 0;
}

async function getMinDepositUSD() {
    try {
        const { data: preferred } = await supabase
            .from('deposit_methods')
            .select('min_amount')
            .eq('currency', 'USD')
            .eq('name', 'Tarjeta Clásica')
            .maybeSingle();

        if (preferred && preferred.min_amount !== null) {
            return parseFloat(preferred.min_amount);
        }

        const { data } = await supabase
            .from('deposit_methods')
            .select('min_amount')
            .eq('currency', 'USD')
            .not('min_amount', 'is', null)
            .order('min_amount', { ascending: true })
            .limit(1);

        if (data && data.length > 0 && data[0].min_amount !== null) {
            return parseFloat(data[0].min_amount);
        }
    } catch (e) {}
    return 0;
}

async function getMinWithdrawUSD() {
    const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'min_withdraw_usd')
        .single();
    return data ? parseFloat(data.value) : 1.0;
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

    if (betType === 'fijo' || betType === 'corridos') {
        const out = [];
        for (let i = 0; i <= 9; i++) {
            out.push(prefix === 'D' ? `${digit}${i}` : `${i}${digit}`);
        }
        return out;
    }

    return [];
}

function normalizeParleValue(value) {
    const match = String(value || '').trim().match(/^(\d{2})\s*x\s*(\d{2})$/i);
    if (!match) return null;
    return [match[1], match[2]].sort().join('x');
}

function formatBetTypeLabel(betType) {
    const labels = {
        fijo: 'Fijo',
        corridos: 'Corridos',
        centena: 'Centena',
        parle: 'Parle'
    };
    return labels[String(betType || '').toLowerCase()] || (betType || 'N/D');
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
                { name: '🌅 Mañana', end: 13.25 },
                { name: '🌙 Noche', end: 21.25 }
            ]
        },
        georgia: {
            slots: [
                { name: '🌅 Mañana', end: 12.25 },
                { name: '☀️ Tarde', end: 18.75 },
                { name: '🌙 Noche', end: 23.25 }
            ]
        },
        newyork: {
            slots: [
                { name: '🌅 Mañana', end: 14.25 },
                { name: '🌙 Noche', end: 22.25 }
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
    let userId = req.verifiedTelegramId || req.body.userId || req.query.userId || req.headers['x-telegram-id'];
    if (!userId) {
        return res.status(403).json({ error: 'No autorizado: falta userId' });
    }
    if (!isAdmin(userId)) {
        return res.status(403).json({ error: 'No autorizado: no eres admin' });
    }
    next();
}

// ========== MIDDLEWARE DE SEGURIDAD: verifica initData en cada petición ==========
app.use(async (req, res, next) => {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return next(); // endpoints públicos pueden seguir sin él

    const decoded = decodeURIComponent(initData);
    const verified = verifyTelegramWebAppData(decoded, BOT_TOKEN);
    if (!verified) {
        return res.status(401).json({ error: 'Firma de Telegram inválida' });
    }

    const params = new URLSearchParams(decoded);
    const userStr = params.get('user');
    if (userStr) {
        try {
            const tgUser = JSON.parse(userStr);
            req.verifiedTelegramId = tgUser.id;   // <-- ID confiable
        } catch (e) {}
    }
    next();
});

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
    if (user && user.is_banned) {
        return res.status(403).json({ error: 'Tu cuenta ha sido baneada.' });
    }
    const isNewUser = !!user?.__isNewUser;
    if (user && typeof user === 'object' && '__isNewUser' in user) {
        delete user.__isNewUser;
    }
    const rates = await getExchangeRates();

    const botInfo = await axios.get(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`)
        .then(r => r.data.result)
        .catch(() => ({ username: 'bot', first_name: 'Bot' }));

    res.json({
        user,
        isNewUser,
        isAdmin: isAdmin(tgUser.id),
        roles: await getUserRoles(tgUser.id),
        exchangeRate: rates.rate,
        exchangeRateMLC: rates.rate_mlc,
        exchangeRateUSDT: rates.rate_usdt,
        exchangeRateTRX: rates.rate_trx,
        botUsername: botInfo.username,
        botDisplayName: botInfo.first_name || botInfo.username || '4pu3$t4$ Qva®',
        bonusCupDefault: await getBonusCupDefault()
    });
});

// --- Obtener mínimos de transferencia (público) ---
app.get('/api/transfer-mins', async (req, res) => {
    const minCup = await getTransferMinCUP();
    const minUsd = await getTransferMinUSD();
    res.json({ min_cup: minCup, min_usd: minUsd });
});

app.get('/api/withdraw-hours', async (req, res) => {
    const start = await getWithdrawTimeStart();
    const end = await getWithdrawTimeEnd();
    res.json({ start, end });
});

// --- Tasa de comisión de referidos (pública, para mostrar en la web) ---
app.get('/api/referral-rate', async (req, res) => {
    const rate = await getReferralCommissionRate();
    res.json({ rate });
});

// --- Métodos de depósito ---
app.get('/api/deposit-methods', async (req, res) => {
    const { data } = await supabase.from('deposit_methods').select('*').order('name');
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
    const { data } = await supabase.from('withdraw_methods').select('*').order('name');
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
    const usd = await getMinDepositUSD();
    const cup = await getMinDepositCUP();
    res.json({ usd, cup });
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
    const { methodId, amount, currency } = req.body;
    const userId = req.verifiedTelegramId || req.body.userId;
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
            amount: parsed.amount,
            currency,
            status: 'pending'
        })
        .select()
        .single();

    if (insertError) {
        return res.status(500).json({ error: 'Error al guardar solicitud' });
    }

    await ensureRolesCache();
    const notifyIds = new Set([...ADMIN_IDS.map(id => Number(id)), ...rolesCache.depositApprovers]);
    const depKey = `deposit_${request.id}`;
    const depEntries = [];
    for (const adminId of notifyIds) {
        try {
            const sentMsg = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
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
            if (sentMsg?.data?.result?.message_id) {
                depEntries.push({ chatId: adminId, messageId: sentMsg.data.result.message_id });
            }
        } catch (e) {
            console.error('Error enviando notificación de depósito:', e);
        }
    }
    if (depEntries.length > 0) pendingNotifications.set(depKey, depEntries);

    res.json({ success: true, requestId: request.id });
});

// --- Solicitud de retiro ---
app.post('/api/withdraw-requests', async (req, res) => {

    const { methodId, amount, currency, accountInfo } = req.body;
    const userId = req.verifiedTelegramId || req.body.userId;
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

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ error: 'Monto inválido' });
    }

    if (method.min_amount !== null && parsedAmount < method.min_amount) {
        return res.status(400).json({ error: `Monto mínimo: ${method.min_amount} ${currency}` });
    }
    if (method.max_amount !== null && parsedAmount > method.max_amount) {
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

    await ensureRolesCache();
    const notifyIds = new Set([...ADMIN_IDS.map(id => Number(id)), ...rolesCache.withdrawApprovers]);
    const wdKey = `withdraw_${request.id}`;
    const wdEntries = [];
    for (const adminId of notifyIds) {
        try {
            const sentMsg = await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
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
            if (sentMsg?.data?.result?.message_id) {
                wdEntries.push({ chatId: adminId, messageId: sentMsg.data.result.message_id });
            }
        } catch (e) {}
    }
    if (wdEntries.length > 0) pendingNotifications.set(wdKey, wdEntries);

    res.json({ success: true, requestId: request.id });
});

// --- Transferencia entre usuarios ---
app.post('/api/transfer', async (req, res) => {
    const { to, amount, currency } = req.body;
    const from = req.verifiedTelegramId || req.body.from;
    const selfTransferErrorMessage = '❌ No puedes transferirte saldo a ti mismo. Elige otro usuario.\nPor favor, vuelve a iniciar la operación';
    if (!from || !to || !amount || !currency || amount <= 0) {
        return res.status(400).json({ error: 'Datos inválidos' });
    }
    if (!['CUP', 'USD'].includes(currency)) {
        return res.status(400).json({ error: 'Moneda no soportada. Usa CUP o USD' });
    }

    const parsedAmount = parseFloat(amount);

    // Idempotencia: si el cliente envía un idempotencyKey, evitar doble proceso
    const idempotencyKey = req.body.idempotencyKey || req.headers['x-idempotency-key'];
    if (idempotencyKey) {
        const cached = transferIdempotencyStore.get(idempotencyKey);
        if (cached) {
            return res.json(cached.response);
        }
    }

    // Intentar obtener el mínimo configurado por el admin
    let minByCurrency = null;
    if (currency === 'CUP') {
        minByCurrency = await getTransferMinCUP();
    } else if (currency === 'USD') {
        minByCurrency = await getTransferMinUSD();
    }

    // Si no está configurado un mínimo de transferencia explícito, usar el mínimo global de depósito
    if (minByCurrency === null) {
        if (currency === 'CUP') minByCurrency = await getMinDepositCUP();
        else if (currency === 'USD') minByCurrency = await getMinDepositUSD();
    }

    // Si después de todo no hay mínimo (o es 0), no validamos mínimo
    if (minByCurrency !== null && minByCurrency > 0 && parsedAmount < minByCurrency) {
        return res.status(400).json({ error: `El monto mínimo para transferir en ${currency} es ${minByCurrency.toFixed(2)} ${currency}.` });
    }

    if (from === to) {
        return res.status(400).json({ error: selfTransferErrorMessage });
    }

    const userFrom = await getOrCreateUser(parseInt(from));
    if (!userFrom) return res.status(404).json({ error: 'Usuario origen no encontrado' });

    // Estado para rollback
    let debitDone = false;
    const originalCup = parseFloat(userFrom.cup) || 0;
    const originalUsd = parseFloat(userFrom.usd) || 0;

    try {

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
    if (targetUserId === parseInt(from)) {
        return res.status(400).json({ error: selfTransferErrorMessage });
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
    debitDone = true;

    // ---------- ACREDITAR AL RECEPTOR (LÓGICA ROBUSTA) ----------
    const { data: freshTarget } = await supabase
        .from('users')
        .select('*')
        .eq('telegram_id', targetUserId)
        .single();
    const targetBefore = freshTarget || targetUser;

    // Valores reales de la BD antes de cualquier cambio
    const targetCupBefore = parseFloat(targetBefore.cup) || 0;
    const targetUsdBefore = parseFloat(targetBefore.usd) || 0;
    let targetBonus = (() => {
        const raw = targetBefore.bonus_cup;
        return (raw !== null && raw !== undefined && !isNaN(parseFloat(raw))) ? parseFloat(raw) : 0;
    })();

    const originalTargetBonus = targetBonus; // Bono real antes de la transferencia

    const hasMainBalanceBefore = (targetCupBefore > 0) || (targetUsdBefore > 0);
    const hasApprovedDep = await userHasApprovedDeposit(targetUserId);
    const isCompletelyNew = !hasApprovedDep && !hasMainBalanceBefore;

    const rateUSD = await getExchangeRateUSD();
    const minDepositCUP = await getMinDepositCUP();
    const minDepositUSD = await getMinDepositUSD();

    const thresholdForBonusMigration = currency === 'USD'
    ? minDepositUSD * rateUSD
    : minDepositCUP;

    let finalCup = targetCupBefore;
    let finalUsd = targetUsdBefore;
    let finalBonus = targetBonus;
    let bonusMovedCup = 0; // Para notificación

    // Paso 1: Ubicar el monto transferido
    if (isCompletelyNew) {
        // El importe va al bono, convertido a CUP
        if (currency === 'CUP') {
            finalBonus += parsedAmount;
        } else if (currency === 'USD') {
            finalBonus += parsedAmount * rateUSD;
        }
    } else {
        // Ya tiene saldo → acreditar en la moneda enviada
        if (currency === 'CUP') {
            finalCup += parsedAmount;
        } else if (currency === 'USD') {
            finalUsd += parsedAmount;
        }
    }

    // Paso 2: Migración del bono (si el total en CUP alcanza el mínimo)
    if (finalBonus > 0) {
        const totalEquivalentCUP = finalCup
            + (finalUsd * rateUSD)
            + finalBonus;

        if (totalEquivalentCUP >= thresholdForBonusMigration) {
            // Determinar cuánto bono proviene de esta transferencia (si la hubo)
            if (isCompletelyNew && currency === 'USD') {
                // Transferencia en USD a un nuevo: revertir la conversión a CUP
                // y dejar la transferencia en USD, el resto del bono (si había) pasa a CUP
                const transferWorthCUP = parsedAmount * rateUSD;

                finalUsd += parsedAmount;            // la transferencia en USD
                finalCup += originalTargetBonus;      // bono anterior → CUP
                bonusMovedCup = originalTargetBonus; // ✅ solo el bono previo
                finalBonus = 0;
            } else {
                // Caso general: todo el bono pasa a CUP
                finalCup += finalBonus;
                bonusMovedCup = originalTargetBonus; // ✅ solo el bono previo
                finalBonus = 0;
            }
        }
    }

    // Guardar en BD
    const targetUpdatePayload = {
        cup: finalCup,
        usd: finalUsd,
        bonus_cup: finalBonus,
        updated_at: new Date()
    };
    await supabase.from('users')
        .update(targetUpdatePayload)
        .eq('telegram_id', targetUserId);

    // Notificar al receptor (formato original adaptado)
    try {
        const fromName = (userFrom?.first_name || userFrom?.username) ? 
            (userFrom.first_name || userFrom.username) : String(from);
        let message = `🔄 <b>Has recibido una transferencia</b>\n\n` +
            `👤 De: ${escapeHTML(fromName)}\n`;

        if (currency === 'USD') {
            message += `💰 Monto: ${parsedAmount} USD\n` + `ℹ️ Con tu saldo USD también puedes transferir en CUP; además retirar en CUP, USDT, TRX o MLC según los métodos disponibles.\n`;
        } else {
            message += `💰 Monto: ${parsedAmount} CUP\n`;
        }

        if (isCompletelyNew) {
            if (bonusMovedCup > 0) {
                message += `🎁 Tu bono de bienvenida de ${originalTargetBonus.toFixed(2)} CUP se ha movido a tu saldo principal.\n`;
            } else if (finalBonus > 0) {
                if (currency === 'USD') {
                    const addedCUP = (parsedAmount * rateUSD).toFixed(2);
                    message += `🎁 Han sido añadidos ${addedCUP} CUP a tu bono de bienvenida actual.\n`;
                } else {
                    message += `🎁 Han sido añadidos ${parsedAmount.toFixed(2)} CUP a tu bono de bienvenida actual.\n`;
                }
            }
        }

        message += `📊 Saldo actualizado.`;

        if (bot && bot.telegram && typeof bot.telegram.sendMessage === 'function') {
            await bot.telegram.sendMessage(targetUserId, message, { parse_mode: 'HTML' });
        } else {
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

    const responsePayload = { success: true, bonusMovedCup };
    if (idempotencyKey) {
        transferIdempotencyStore.set(idempotencyKey, { response: responsePayload, timestamp: Date.now() });
    }
    res.json(responsePayload);
    } catch (e) {
        console.error('Error en POST /api/transfer:', e?.message || e);
        if (debitDone) {
            try {
                await supabase.from('users').update({
                    cup: originalCup,
                    usd: originalUsd,
                    updated_at: new Date()
                }).eq('telegram_id', from);
            } catch (rollbackErr) {
                console.error('Error en rollback de transferencia:', rollbackErr?.message || rollbackErr);
            }
        }
        if (!res.headersSent) {
            return res.status(500).json({ error: 'Error al procesar la transferencia. Si el saldo fue debitado, contacta al administrador.' });
        }
    }
});

// --- Registro de apuestas ---
app.post('/api/bets', async (req, res) => {
    const { lottery, betType, rawText, sessionId, betId } = req.body;
    const userId = req.verifiedTelegramId || req.body.userId;
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

    // Si NO se está editando (no se proporcionó betId), verificar tempranamente
    // que el usuario tenga saldo suficiente (cup + bonus_cup) para cubrir la apuesta.
    // En el caso de edición el flujo más abajo reembolsa primero la apuesta anterior
    // y luego vuelve a intentar descontar, por lo que esta verificación impediría
    // la edición legítima; por eso solo la aplicamos para nuevas apuestas.
    if (!betId) {
        const userCup = parseFloat(user.cup) || 0;
        const userBonusCup = parseFloat(user.bonus_cup) || 0;
        const availableCupNow = userCup + userBonusCup;
        if (totalCUP > 0 && availableCupNow < totalCUP) {
            return res.status(400).json({ error: '❌ Saldo CUP insuficiente. Por favor, recarga', debug: { userCup, userBonusCup, availableCupNow, totalCUP, parsed } });
        }
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

        // --- Datos de la apuesta original y balances actuales del apostador ---
        const { data: uBefore } = await supabase.from('users').select('usd,cup,bonus_cup').eq('telegram_id', userId).single();
        const beforeUsd = safe(uBefore.usd);
        const beforeCup = safe(uBefore.cup);
        const beforeBonus = safe(uBefore.bonus_cup);

        const oldBonusUsed = safe(existingBet.bonus_used_cup);
        const oldCostCup = safe(existingBet.cost_cup);
        const oldCostUsd = safe(existingBet.cost_usd);

        // ---------- REVERTIR COMISIÓN ANTERIOR (SIN NOTIFICAR AÚN) ----------
        let referrerStateAfterRevert = { cup: 0, usd: 0, bonus_cup: 0 };
        let oldReferrerId = null;

        if (existingBet.referrer_id && existingBet.commission_amount > 0) {
            oldReferrerId = existingBet.referrer_id;
            const oldCommission = parseFloat(existingBet.commission_amount);
            const oldDestination = existingBet.commission_destination || 'cup';
            const oldBonusBefore = parseFloat(existingBet.referrer_bonus_before) || 0;

            const { data: oldReferrer } = await supabase
                .from('users')
                .select('cup, usd, bonus_cup')
                .eq('telegram_id', oldReferrerId)
                .single();

            if (oldReferrer) {
                let cupAfter = parseFloat(oldReferrer.cup) || 0;
                let usdAfter = parseFloat(oldReferrer.usd) || 0;
                let bonusAfter = parseFloat(oldReferrer.bonus_cup) || 0;

                // 1. Revertir la comisión en sí
                if (oldDestination === 'cup') {
                    cupAfter = Math.max(0, cupAfter - oldCommission);
                } else if (oldDestination === 'usd') {
                    usdAfter = Math.max(0, usdAfter - oldCommission);
                } else if (oldDestination === 'bonus_cup') {
                    if (bonusAfter >= oldCommission) {
                        bonusAfter -= oldCommission;
                    } else {
                        const remaining = oldCommission - bonusAfter;
                        cupAfter = Math.max(0, cupAfter - remaining);
                        bonusAfter = 0;
                    }
                }

                // 2. Revertir migración del bono si ocurrió
                if (oldBonusBefore > 0) {
                    const toReturn = Math.min(cupAfter, oldBonusBefore);
                    if (toReturn > 0) {
                        cupAfter -= toReturn;
                        bonusAfter += toReturn;
                    }
                }

                referrerStateAfterRevert = { cup: cupAfter, usd: usdAfter, bonus_cup: bonusAfter };
                // ❗️ NO se envía notificación aquí
            }
        }

        // ---------- REEMBOLSAR ANTIGUA APUESTA AL USUARIO ----------
        let finalCup = beforeCup + (oldCostCup - oldBonusUsed);
        let finalBonus = beforeBonus + oldBonusUsed;
        let finalUsd = beforeUsd + oldCostUsd;

        // ---------- VALIDACIÓN DE SALDO SUFICIENTE (NUEVA) ----------
        if (totalCUP > 0) {
            const availableCup = finalCup + finalBonus;
            if (availableCup < totalCUP) {
                return res.status(400).json({ error: '❌ Saldo CUP insuficiente para la edición. Por favor, recarga.' });
            }
        }
        if (totalUSD > 0) {
            if (finalUsd < totalUSD) {
                return res.status(400).json({ error: '❌ Saldo USD insuficiente para la edición. Por favor, recarga.' });
            }
        }

        // ---------- CALCULAR NUEVA COMISIÓN (SOLO CUP) ----------
        let newCommissionData = null;
        const { data: userWithRef } = await supabase
            .from('users')
            .select('ref_by')
            .eq('telegram_id', userId)
            .single();

        if (userWithRef && userWithRef.ref_by) {
            const newReferrerId = userWithRef.ref_by;
            let newReferrer;
            if (newReferrerId === oldReferrerId) {
                newReferrer = referrerStateAfterRevert;
            } else {
                const { data: fetched } = await supabase
                    .from('users')
                    .select('cup, usd, bonus_cup')
                    .eq('telegram_id', newReferrerId)
                    .single();
                newReferrer = fetched || { cup: 0, usd: 0, bonus_cup: 0 };
            }

            const usdRate = await getExchangeRateUSD();
            let effectiveRate = await getReferralCommissionRate();

            // Conservar tasa efectiva si ya existía comisión en CUP
            if (existingBet.commission_amount > 0 && existingBet.commission_currency === 'CUP') {
                const oldTotalCUP = parseFloat(existingBet.cost_cup || 0) + parseFloat(existingBet.cost_usd || 0) * usdRate;
                if (oldTotalCUP > 0) {
                    effectiveRate = parseFloat(existingBet.commission_amount) / oldTotalCUP;
                }
            }

            const newTotalCostCUP = (totalCUP || 0) + ((totalUSD || 0) * usdRate);
            const newCommissionCUP = newTotalCostCUP * effectiveRate;

            if (newCommissionCUP > 0) {
                let newCup = parseFloat(newReferrer.cup) || 0;
                let newUsd = parseFloat(newReferrer.usd) || 0;
                let newBonus = parseFloat(newReferrer.bonus_cup) || 0;

                const hasMainBalance = (newCup > 0) || (newUsd > 0);
                const hasOnlyBonus = (!hasMainBalance && newBonus > 0);
                let destination = 'cup';
                let bonusMovedCup = 0;

                if (hasMainBalance) {
                    newCup += newCommissionCUP;
                } else if (hasOnlyBonus) {
                    const minDepositCUP = await getMinDepositCUP();
                    if ((newBonus + newCommissionCUP) >= minDepositCUP) {
                        newCup += newBonus + newCommissionCUP;
                        bonusMovedCup = newBonus;
                        newBonus = 0;
                    } else {
                        newBonus += newCommissionCUP;
                        destination = 'bonus_cup';
                    }
                } else {
                    newCup += newCommissionCUP;
                }

                const updatePayload = { updated_at: new Date() };
                if (newCup !== (parseFloat(newReferrer.cup) || 0)) updatePayload.cup = newCup;
                if (newBonus !== (parseFloat(newReferrer.bonus_cup) || 0)) updatePayload.bonus_cup = newBonus;

                newCommissionData = {
                    referrer_id: newReferrerId,
                    commission_amount: newCommissionCUP,
                    commission_currency: 'CUP',
                    commission_destination: destination,
                    bonusMovedCup: bonusMovedCup,
                    // Guardamos los saldos finales para escribirlos después
                    referrer_cup: newCup,
                    referrer_bonus_cup: newBonus
                };

                const bettorName = user.first_name || user.username || `ID ${userId}`;

                // --- Notificación ÚNICA al referidor ---
                if (bonusMovedCup > 0) {
                    // Con migración de bono
                    const bonusMovedStr = bonusMovedCup.toFixed(2);
                    const notifyMsg = `ℹ️ Tu referido <b>${escapeHTML(bettorName)}</b> ha editado el monto de una apuesta. Tu saldo actual ha cambiado. Por favor, consulta.\n🎁 Tu bono de bienvenida de ${bonusMovedStr} CUP se ha movido a tu saldo principal.\n📊 Saldo actualizado.`;
                    try {
                        if (bot && bot.telegram) {
                            await bot.telegram.sendMessage(newReferrerId, notifyMsg, { parse_mode: 'HTML' });
                        } else {
                            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                chat_id: newReferrerId,
                                text: notifyMsg,
                                parse_mode: 'HTML'
                            }).catch(() => {});
                        }
                    } catch (e) {}
                } else {
                    // Sin migración, solo aviso genérico
                    try {
                        const genericMsg = `ℹ️ Tu referido <b>${escapeHTML(bettorName)}</b> ha editado el monto de una apuesta. Tu saldo actual ha cambiado. Por favor, consulta.`;
                        if (bot && bot.telegram) {
                            await bot.telegram.sendMessage(newReferrerId, genericMsg, { parse_mode: 'HTML' });
                        } else {
                            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                chat_id: newReferrerId,
                                text: genericMsg,
                                parse_mode: 'HTML'
                            }).catch(() => {});
                        }
                    } catch (e) {}
                }
            }
        }

        // ========== PERSISTIR CAMBIOS DE COMISIÓN (SOLO SI LA VALIDACIÓN FUE EXITOSA) ==========
        if (newCommissionData && newCommissionData.referrer_id) {
            await supabase
                .from('users')
                .update({
                    cup: newCommissionData.referrer_cup,
                    bonus_cup: newCommissionData.referrer_bonus_cup,
                    updated_at: new Date()
                })
                .eq('telegram_id', newCommissionData.referrer_id);
        } else if (oldReferrerId) {
            // No hay nueva comisión, pero sí se revirtió una anterior: persistir la reversión
            await supabase
                .from('users')
                .update({
                    cup: referrerStateAfterRevert.cup,
                    usd: referrerStateAfterRevert.usd,
                    bonus_cup: referrerStateAfterRevert.bonus_cup,
                    updated_at: new Date()
                })
                .eq('telegram_id', oldReferrerId);
        }

        // ---------- DESCONTAR NUEVA APUESTA ----------
        let nuevoBonusUsed = 0;
        if (totalCUP > 0) {
            const cupDisponible = finalCup;
            const cupADebitar = Math.min(cupDisponible, totalCUP);
            finalCup -= cupADebitar;
            const remainingCUP = totalCUP - cupADebitar;
            if (remainingCUP > 0) {
                const bonusADebitar = Math.min(finalBonus, remainingCUP);
                finalBonus -= bonusADebitar;
                nuevoBonusUsed = bonusADebitar;
            }
        }
        if (totalUSD > 0) {
            finalUsd -= totalUSD;
        }

        // Actualizar saldos del usuario
        const { error: userUpdateError } = await supabase
            .from('users')
            .update({ cup: finalCup, usd: finalUsd, bonus_cup: finalBonus, updated_at: new Date() })
            .eq('telegram_id', userId);

        if (userUpdateError) {
            console.error('Error aplicando actualización de saldos para edición:', userUpdateError);
            return res.status(500).json({ error: 'Error al procesar la edición' });
        }

        // Construir el objeto de actualización de la apuesta
        const updateBetPayload = {
            raw_text: rawText,
            items: parsed.items,
            cost_usd: totalUSD,
            cost_cup: totalCUP,
            bonus_used_cup: nuevoBonusUsed,
            updated_at: new Date()
        };
        if (newCommissionData) {
            updateBetPayload.referrer_id = newCommissionData.referrer_id;
            updateBetPayload.commission_amount = newCommissionData.commission_amount;
            updateBetPayload.commission_currency = newCommissionData.commission_currency;
            updateBetPayload.commission_destination = newCommissionData.commission_destination;
            updateBetPayload.referrer_bonus_before = newCommissionData.bonusMovedCup || 0;
        } else {
            updateBetPayload.referrer_id = null;
            updateBetPayload.commission_amount = 0;
            updateBetPayload.commission_currency = 'CUP';
            updateBetPayload.commission_destination = null;
            updateBetPayload.referrer_bonus_before = 0;
        }

        // Guardar apuesta actualizada
        const { data: updatedBet, error: updateError } = await supabase
            .from('bets')
            .update(updateBetPayload)
            .eq('id', betId)
            .select()
            .single();

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
        if (newUsd < totalUSD) return res.status(400).json({ error: '❌ Saldo USD insuficiente. Por favor, recarga.' });
        newUsd -= totalUSD;
    }

    if (totalCUP > 0) {
        // Permitir usar bono en CUP además del saldo CUP
        const availableCupTotal = newCup + newBonus;
        if (availableCupTotal < totalCUP) return res.status(400).json({ error: '❌ Saldo CUP insuficiente. Por favor, recarga' });
        if (newCup >= totalCUP) {
            newCup -= totalCUP;
        } else {
            const deficit = totalCUP - newCup;
            newBonus = Math.max(0, newBonus - deficit);
            newCup = 0;
        }
    }

    //---------- Cambios hechos por Luis David ----------//
    // Calcular desglose del pago
    
    let bonusUsed = 0;
    if (totalCUP > 0) {
        const cupBalance = parseFloat(user.cup) || 0;
        const cupDebit = Math.min(cupBalance, totalCUP);
        bonusUsed = totalCUP - cupDebit;
    }

    await supabase.from('users').update({ usd: newUsd, bonus_cup: newBonus, cup: newCup, updated_at: new Date() }).eq('telegram_id', userId);

    // Anadida la nueva variable (usdUsed)

    const { data: bet, error: betError } = await supabase.from('bets').insert({ user_id: parseInt(userId), lottery, session_id: sessionId || null, bet_type: betType, raw_text: rawText, items: parsed.items, cost_usd: totalUSD, cost_cup: totalCUP, bonus_used_cup: bonusUsed, placed_at: new Date() }).select().single();
    if (betError) {
        console.error('Error insertando apuesta:', betError);
        return res.status(500).json({ error: 'Error al registrar la apuesta' });
    }

    // ==========    ==========
    if (bet && !betId) {
        const { data: userWithRef } = await supabase
            .from('users')
            .select('ref_by')
            .eq('telegram_id', userId)
            .single();

        if (userWithRef && userWithRef.ref_by) {
            const referrerId = userWithRef.ref_by;
            const referrerName = user.first_name || user.username || 'Usuario';
            const referralRate = await getReferralCommissionRate();

            // Obtener datos del referidor
            const { data: referrer } = await supabase
                .from('users')
                .select('cup, usd, bonus_cup')
                .eq('telegram_id', referrerId)
                .single();

            if (referrer) {
                // ========== LÓGICA ORIGINAL UNIFICADA A CUP ==========
                const usdRate = await getExchangeRateUSD();
                const totalCostCUP = (totalCUP || 0) + ((totalUSD || 0) * usdRate);
                const commissionCUP = totalCostCUP * referralRate;

                if (commissionCUP > 0) {
                    let newCup = parseFloat(referrer.cup) || 0;
                    let newUsd = parseFloat(referrer.usd) || 0;
                    let newBonus = parseFloat(referrer.bonus_cup) || 0;

                    const hasMainBalance = (newCup > 0) || (newUsd > 0);
                    const hasOnlyBonus = (!hasMainBalance && newBonus > 0);

                    let destination = 'cup';
                    let bonusMovedCup = 0;

                    if (hasMainBalance) {
                        newCup += commissionCUP;
                        destination = 'cup';
                    } else if (hasOnlyBonus) {
                        const minDepositCUP = await getMinDepositCUP();
                        if ((newBonus + commissionCUP) >= minDepositCUP) {
                            newCup += newBonus + commissionCUP;
                            bonusMovedCup = newBonus;
                            newBonus = 0;
                            destination = 'cup';
                        } else {
                            newBonus += commissionCUP;
                            destination = 'bonus_cup';
                        }
                    } else {
                        newCup += commissionCUP;
                        destination = 'cup';
                    }

                    const updatePayload = { updated_at: new Date() };
                    if (newCup !== (parseFloat(referrer.cup) || 0)) updatePayload.cup = newCup;
                    if (newBonus !== (parseFloat(referrer.bonus_cup) || 0)) updatePayload.bonus_cup = newBonus;

                    await supabase
                        .from('users')
                        .update(updatePayload)
                        .eq('telegram_id', referrerId);

                    let notifyMessage = `🔄 Has recibido una referencia\n\n` +
                        `👤 De: ${escapeHTML(referrerName)}\n` +
                        `💰 Monto: ${commissionCUP.toFixed(2)} CUP\n`;
                    
                    if (bonusMovedCup > 0) {
                        // Migración del bono al principal
                        notifyMessage += `🎁 Tu bono de bienvenida de ${bonusMovedCup.toFixed(2)} CUP se ha movido a tu saldo principal.\n`;
                    } else if (destination === 'bonus_cup') {
                        // Se añadió al bono sin migrar
                        notifyMessage += `🎁 La referencia ha sido añadida a tu bono de bienvenida actual.\n`;
                    } else {
                        notifyMessage += `🎁 La referencia ha sido añadida a tu saldo principal.\n`;
                    }
                    notifyMessage += `📊 Saldo actualizado.`;

                    try {
                        if (bot && bot.telegram) {
                            await bot.telegram.sendMessage(referrerId, notifyMessage, { parse_mode: 'HTML' });
                        } else {
                            await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                                chat_id: referrerId,
                                text: notifyMessage,
                                parse_mode: 'HTML'
                            }).catch(() => {});
                        }
                    } catch (e) {
                        console.warn('Error notificando al referidor:', e.message);
                    }

                    await supabase
                        .from('bets')
                        .update({
                            referrer_id: referrerId,
                            commission_amount: commissionCUP,
                            commission_currency: 'CUP',
                            commission_destination: destination,
                            referrer_bonus_before: bonusMovedCup
                        })
                        .eq('id', bet.id);
                }
            }
        }
    }
    const updatedUser = await getOrCreateUser(parseInt(userId));
    res.json({ success: true, bet, updatedUser });
});

// --- Cancelar jugada ---
app.post('/api/bets/:id/cancel', async (req, res) => {
    const { id } = req.params;
    const userId = req.verifiedTelegramId || req.body.userId;
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

    //----------- Cambios hechos por Luis David -----------//
    // ========== REVERTIR COMISIÓN DEL REFERIDOR (SIMPLIFICADO) ==========
    if (bet.referrer_id && bet.commission_amount > 0) {
        const referrerId = bet.referrer_id;
        const commissionAmount = parseFloat(bet.commission_amount);
        const destination = bet.commission_destination || 'cup';

        const { data: referrer } = await supabase
            .from('users')
            .select('cup, usd, bonus_cup')
            .eq('telegram_id', referrerId)
            .single();

        if (referrer) {
            let newCup = parseFloat(referrer.cup) || 0;
            let newUsd = parseFloat(referrer.usd) || 0;
            let newBonus = parseFloat(referrer.bonus_cup) || 0;

            if (destination === 'cup') {
                newCup = Math.max(0, newCup - commissionAmount);
            } else if (destination === 'usd') {
                newUsd = Math.max(0, newUsd - commissionAmount);
            } else if (destination === 'bonus_cup') {
                if (newBonus >= commissionAmount) {
                    newBonus -= commissionAmount;
                } else {
                    const remaining = commissionAmount - newBonus;
                    newCup = Math.max(0, newCup - remaining);
                    newBonus = 0;
                }
            }

            await supabase
                .from('users')
                .update({ cup: newCup, usd: newUsd, bonus_cup: newBonus, updated_at: new Date() })
                .eq('telegram_id', referrerId);

            // ===== REVERTIR MIGRACIÓN DEL BONO POR COMISIÓN =====
            const bonusMoved = parseFloat(bet.referrer_bonus_before) || 0;
            if (bonusMoved > 0 && bet.referrer_id) {
                const { data: refAfter } = await supabase
                    .from('users')
                    .select('cup, bonus_cup')
                    .eq('telegram_id', bet.referrer_id)
                    .single();
                if (refAfter) {
                    let cupA = parseFloat(refAfter.cup) || 0;
                    let bonA = parseFloat(refAfter.bonus_cup) || 0;
                    const toReturn = Math.min(cupA, bonusMoved);
                    if (toReturn > 0) {
                        cupA -= toReturn;
                        bonA += toReturn;
                        await supabase
                            .from('users')
                            .update({ cup: cupA, bonus_cup: bonA, updated_at: new Date() })
                            .eq('telegram_id', bet.referrer_id);
                    }
                }
            }

            // Notificar al referidor (mantener lógica existente o usar la simplificada)
            try {
                const bettorName = user.first_name || user.username || `ID ${userId}`;
                const userName = user.first_name || user.username || `ID ${userId}`;

                const referralRate = await getReferralCommissionRate();
                const percent = referralRate * 100;
                // Formateo limpio: sin decimales si es entero, o hasta 2 decimales
                const percentStr = (percent % 1 === 0 ? percent.toFixed(0) : percent.toFixed(2)) + '%';
                await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
                    chat_id: referrerId,
                    text: `⚠️ Tu referido <b>${escapeHTML(bettorName)}</b> ha removido una apuesta. Ha sido restado de tu saldo actual el ${percentStr} del monto retirado en la apuesta removida.`,
                    parse_mode: 'HTML'
                });
            } catch (e) {}
        }
    }
    
    //---------- Cambios hechos por Luis David ----------//
    // Eliminamos la vieja logica y calcular los nuevos parametros introducidos

    let newCup = parseFloat(user.cup) || 0;
    let newUsd = parseFloat(user.usd) || 0;
    let newBonus = parseFloat(user.bonus_cup) || 0;

    // Usar el desglose guardado en la apuesta
    const bonusUsed = parseFloat(bet.bonus_used_cup) || 0;
    const costCup = parseFloat(bet.cost_cup) || 0;
    const costUsd = parseFloat(bet.cost_usd) || 0;

    newCup += (costCup - bonusUsed);
    newBonus += bonusUsed;
    newUsd += costUsd;

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

//---------- Cambios hechos por Luis David ----------//
// --- Estadísticas completas de referidos (para la web) ---
app.get('/api/user/:userId/referrals', async (req, res) => {
    const { userId } = req.params;
    const refUserId = parseInt(userId);
    if (isNaN(refUserId)) return res.status(400).json({ error: 'ID de usuario inválido' });

    try {
        // 1. Obtener lista de referidos
        const { data: referidos, error: refError } = await supabase
            .from('users')
            .select('telegram_id, first_name, username')
            .eq('ref_by', refUserId);

        if (refError) {
            console.error('Error fetching referrals:', refError);
            return res.status(500).json({ error: 'Error al consultar referidos' });
        }

        const totalReferidos = referidos?.length || 0;
        let totalAportadoCUP = 0;
        let referredList = [];

        if (totalReferidos > 0) {
            // 2. Obtener comisiones generadas por referidos
            const { data: comisiones, error: comError } = await supabase
                .from('bets')
                .select('user_id, commission_amount, commission_currency')
                .eq('referrer_id', refUserId)
                .gt('commission_amount', 0);

            if (comError) {
                console.error('Error fetching commissions:', comError);
                // Continuamos sin datos de comisiones
            }

            const aportePorUsuario = new Map();
            // Inicializar con todos los referidos
            for (const ref of referidos) {
                const nombre = ref.username ? `@${ref.username}` : (ref.first_name || `ID ${ref.telegram_id}`);
                aportePorUsuario.set(ref.telegram_id, { telegram_id: ref.telegram_id, name: nombre, totalCUP: 0 });
            }

            // Procesar comisiones
            if (comisiones && comisiones.length > 0) {
                const tasaUSD = await getExchangeRateUSD();
                for (const com of comisiones) {
                    const userIdRef = com.user_id;
                    const amount = parseFloat(com.commission_amount) || 0;
                    const currency = com.commission_currency;
                    let amountCUP = 0;
                    if (currency === 'USD') {
                        amountCUP = amount * tasaUSD;
                    } else { // CUP
                        amountCUP = amount;
                    }
                    const entry = aportePorUsuario.get(userIdRef);
                    if (entry) {
                        entry.totalCUP += amountCUP;
                    }
                }
            }

            // Convertir a array y ordenar por mayor aporte
            const listado = Array.from(aportePorUsuario.values())
                .sort((a, b) => b.totalCUP - a.totalCUP);

            totalAportadoCUP = listado.reduce((sum, u) => sum + u.totalCUP, 0);
            referredList = listado;
        }

        res.json({
            referralCount: totalReferidos,
            totalEarnedCUP: totalAportadoCUP,
            referredUsers: referredList
        });
    } catch (error) {
        console.error('Error obteniendo estadísticas de referidos:', error);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ========== ENDPOINTS DE ADMIN ==========

// --- Añadir método de depósito ---

// --- Obtener mínimos de transferencia ---
app.get('/api/admin/transfer-mins', requireAdmin, async (req, res) => {
    const minCup = await getTransferMinCUP();
    const minUsd = await getTransferMinUSD();
    res.json({ min_cup: minCup, min_usd: minUsd });
});

// --- Establecer mínimos de transferencia ---
app.put('/api/admin/transfer-mins', requireAdmin, async (req, res) => {
    const { min_cup, min_usd } = req.body;
    if (min_cup === undefined || min_usd === undefined) {
        return res.status(400).json({ error: 'Faltan min_cup o min_usd' });
    }
    const cupVal = parseFloat(min_cup);
    const usdVal = parseFloat(min_usd);
    if (isNaN(cupVal) || cupVal < 0 || isNaN(usdVal) || usdVal < 0) {
        return res.status(400).json({ error: 'Valores inválidos' });
    }
    await setTransferMins(cupVal, usdVal);
    res.json({ success: true });
});

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

app.get('/api/admin/config', requireAdmin, async (req, res) => {
    const bonus = await getBonusCupDefault();
    const rate = await getReferralCommissionRate();
    const withdrawStart = await getWithdrawTimeStart();
    const withdrawEnd = await getWithdrawTimeEnd();
    res.json({ bonusCupDefault: bonus, referralRate: rate, withdrawTimeStart: withdrawStart, withdrawTimeEnd: withdrawEnd });
});

app.put('/api/admin/config', requireAdmin, async (req, res) => {
    const { bonusCupDefault, referralRate, withdrawTimeStart, withdrawTimeEnd } = req.body;
    if (bonusCupDefault !== undefined) {
        await supabase.from('app_config').upsert({ key: 'bonus_cup_default', value: bonusCupDefault.toString() }, { onConflict: 'key' });
    }
    if (referralRate !== undefined) {
        await supabase.from('app_config').upsert({ key: 'referral_commission_rate', value: referralRate.toString() }, { onConflict: 'key' });
    }
    const wasOpen = await isWithdrawTime();

    if (withdrawTimeStart !== undefined) {
        await supabase.from('app_config').upsert({ key: 'withdraw_time_start', value: withdrawTimeStart.toString() }, { onConflict: 'key' });
    }
    if (withdrawTimeEnd !== undefined) {
        await supabase.from('app_config').upsert({ key: 'withdraw_time_end', value: withdrawTimeEnd.toString() }, { onConflict: 'key' });
    }
    if (withdrawTimeStart !== undefined || withdrawTimeEnd !== undefined) {
        const { data: overrideData } = await supabase
            .from('app_config')
            .select('value')
            .eq('key', 'withdraw_manual_override')
            .single();
        const currentOverride = overrideData?.value || 'none';

        if (currentOverride === 'open') {
            await supabase
                .from('app_config')
                .upsert({ key: 'withdraw_schedule_changed', value: 'true' }, { onConflict: 'key' });
        } else if (wasOpen) {
            await supabase
                .from('app_config')
                .upsert({ key: 'withdraw_manual_override', value: 'none' }, { onConflict: 'key' });
            await supabase
                .from('app_config')
                .upsert({ key: 'withdraw_manual_override_expiry', value: null }, { onConflict: 'key' });

            const now = moment.tz(TIMEZONE);
            const currentHour = now.hour() + now.minute() / 60;
            const newStart = withdrawTimeStart !== undefined ? withdrawTimeStart : await getWithdrawTimeStart();
            const newEnd = withdrawTimeEnd !== undefined ? withdrawTimeEnd : await getWithdrawTimeEnd();

            if (currentHour < newStart || currentHour >= newEnd) {
                const startStr = formatHour12(newStart);
                const endStr = formatHour12(newEnd);
                const todayStart = now.clone().startOf('day').add(newStart, 'hours');
                const nextOpeningIsToday = now.isBefore(todayStart);
                const openingDayStr = nextOpeningIsToday ? 'hoy' : 'mañana';
                await broadcastToAllUsers(
                    `⏰ <b>Horario de Retiros CERRADO</b>\n\n` +
                    `La ventana de retiros ha finalizado. Vuelve ${openingDayStr} en su nuevo horario de ${startStr} a ${endStr} (hora Cuba).`
                );
                // Ya se envió el mensaje "nuevo horario", limpiar bandera
                await supabase
                    .from('app_config')
                    .upsert({ key: 'withdraw_schedule_changed', value: 'false' }, { onConflict: 'key' });
            } else {
                await supabase
                    .from('app_config')
                    .upsert({ key: 'withdraw_schedule_changed', value: 'true' }, { onConflict: 'key' });
            }
        } else {
            await supabase
                .from('app_config')
                .upsert({ key: 'withdraw_schedule_changed', value: 'true' }, { onConflict: 'key' });
        }
    }
    res.json({ success: true });
});

// ========== MANUAL TOGGLE DE SESIÓN DE RETIROS ==========
app.post('/api/admin/withdraw-manual-toggle', requireAdmin, async (req, res) => {
    const { action } = req.body;   // 'open' o 'close'
    if (!action || !['open', 'close'].includes(action)) {
        return res.status(400).json({ error: 'Acción inválida. Use "open" o "close".' });
    }

    // Estado antes del cambio
    const before = await isWithdrawTime();

    const start = await getWithdrawTimeStart();
    const end = await getWithdrawTimeEnd();
    const startStr = formatHour12(start);
    const endStr = formatHour12(end);

    // Actualizar el flag de anulación manual
    await supabase
        .from('app_config')
        .upsert({ key: 'withdraw_manual_override', value: action }, { onConflict: 'key' });

    // Verificar si el cambio realmente afectó el estado
    const after = await isWithdrawTime();

    if (before === after) {
        // Estado no cambió (ej: cerrar dentro del horario programado, o abrir cuando ya está abierto)
        return res.status(400).json({
            error: before
                ? 'La sesión ya está abierta por el horario programado. No se puede cerrar manualmente.'
                : 'La sesión ya está cerrada fuera del horario programado.'
        });
    }

    const now = moment.tz(TIMEZONE);
    let expiryDate = null;

    if (action === 'open') {
        const currentHour = now.hour() + now.minute() / 60;
        const insideWindow = currentHour >= start && currentHour < end;
        if (insideWindow) {
            expiryDate = now.clone().startOf('day').add(end, 'hours').toDate();
        } else {
            await clearManualOverrideExpiry();
        }
    } else {
        const todayStart = now.clone().startOf('day').add(start, 'hours');
        if (now.isBefore(todayStart)) {
            expiryDate = todayStart.toDate();
        } else {
            expiryDate = todayStart.add(1, 'day').toDate();
        }
    }

    if (expiryDate) {
        await setManualOverrideExpiry(expiryDate);
    } else {
        await clearManualOverrideExpiry();
    }

    let message = '';
    if (action === 'open') {
        message =
            `⏰ <b>Horario de Retiros ABIERTO</b>\n\n` +
            `Ya puedes solicitar tus retiros desde este momento.\n` +
            `Puedes retirar en CUP, USD, USDT, TRX o MLC según los métodos disponibles.`;
    } else {
        const todayStart = now.clone().startOf('day').add(start, 'hours');
        const nextOpeningIsToday = now.isBefore(todayStart);
        const openingDayStr = nextOpeningIsToday ? 'hoy' : 'mañana';
        const endStrFormatted = formatHour12(end);
        message =
            `⏰ <b>Horario de Retiros CERRADO</b>\n\n` +
            `La ventana de retiros ha finalizado. Se reabrirá ${openingDayStr} de ${startStr} a ${endStrFormatted} (hora Cuba).`;
    }

    await broadcastToAllUsers(message, 'HTML');
    res.json({ success: true });
});

// ========== ESTADO ACTUAL DE RETIROS ==========
app.get('/api/withdraw-status', async (req, res) => {
    const available = await isWithdrawTime();
    const start = await getWithdrawTimeStart();
    const end = await getWithdrawTimeEnd();
    res.json({ available, start, end });
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

// Obtener la tasa de comisión actual
app.get('/api/admin/referral-rate', requireAdmin, async (req, res) => {
    const rate = await getReferralCommissionRate();
    res.json({ rate });
});

// Actualizar la tasa de comisión
app.put('/api/admin/referral-rate', requireAdmin, async (req, res) => {
    const { rate } = req.body;
    if (rate === undefined || isNaN(parseFloat(rate)) || parseFloat(rate) < 0) {
        return res.status(400).json({ error: 'Tasa inválida' });
    }
    await supabase
        .from('app_config')
        .upsert({ key: 'referral_commission_rate', value: rate.toString() }, { onConflict: 'key' });
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
    if (status === 'open') {
        await broadcastToAllUsers(
            `🎲 <b>¡SESIÓN ABIERTA!</b> 🎲\n\n` +
            `✨ La región ${region?.emoji || '🎰'} <b>${data.lottery}</b> acaba de abrir su turno de <b>${data.time_slot}</b>.\n` +
            `💎 ¡Es tu momento! Realiza tus apuestas y llévate grandes premios.\n\n` +
            `⏰ Cierre: ${moment(data.end_time).tz(TIMEZONE).format('HH:mm')} (hora Cuba)\n` +
            `🍀 ¡La suerte te espera!`
        );
    } else {
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
    const normalizedParles = new Set(parles.map(normalizeParleValue).filter(Boolean));

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
                    if (normalizedParles.has(normalizeParleValue(numero))) ganado = true;
                    break;
            }

            if (ganado) {
                const itemUsd = item.usd !== undefined ? parseFloat(item.usd) : (item.currency === 'USD' ? parseFloat(item.amount || 0) : 0);
                const itemCup = item.cup !== undefined ? parseFloat(item.cup) : (item.currency === 'CUP' ? parseFloat(item.amount || 0) : 0);
                premioTotalUSD += (itemUsd || 0) * multiplicador;
                premioTotalCUP += (itemCup || 0) * multiplicador;
            }
        }

        if (premioTotalUSD > 0 || premioTotalCUP > 0) {
            const { data: user } = await supabase
                .from('users')
                .select('first_name')
                .eq('telegram_id', bet.user_id)
                .single();

            const bonusMoved = (globalThis.__bonusMovedByUser && globalThis.__bonusMovedByUser.get(String(bet.user_id))) || 0;
            winners.push({
                user_id: bet.user_id,
                first_name: user?.first_name || 'Usuario',
                prize_usd: premioTotalUSD,
                prize_cup: premioTotalCUP,
                bonus_moved: bonusMoved,
                bet_text: bet.raw_text,
                bet_type: bet.bet_type || ''
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
    const corrido1 = cuarteta.slice(0, 2);
    const corrido2 = cuarteta.slice(2);
    const corridos = [
        fijo,
        corrido1,
        corrido2
    ];
    // Generar todas las combinaciones posibles de parles (ambos órdenes)
    const parlePairs = [
        [fijo, corrido1], [corrido1, fijo],
        [fijo, corrido2], [corrido2, fijo],
        [corrido1, corrido2], [corrido2, corrido1]
    ];
    const parles = parlePairs.map(([a, b]) => `${a}x${b}`);
    const normalizedParles = new Set(parles.map(normalizeParleValue).filter(Boolean));

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

    const formatted = cleanNumber.replace(/(\d{3})(\d{4})/, '$1 $2');
    const BET_TYPE_ORDER = ['fijo', 'corridos', 'centena', 'parle'];
    const userResults = new Map();

    for (const bet of bets || []) {
        if (!userResults.has(bet.user_id)) {
            const { data: user } = await supabase
                .from('users')
                .select('usd, cup')
                .eq('telegram_id', bet.user_id)
                .single();

            userResults.set(bet.user_id, {
                beforeUsd: parseFloat(user?.usd) || 0,
                beforeCup: parseFloat(user?.cup) || 0,
                departments: new Map()
            });
        }

        const result = userResults.get(bet.user_id);
        if (!result.departments.has(bet.bet_type)) {
            result.departments.set(bet.bet_type, {
                won: false,
                premioUSD: 0,
                premioCUP: 0
            });
        }

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
                    if (normalizedParles.has(normalizeParleValue(numero))) ganado = true;
                    break;
            }

            if (ganado) {
                const itemUsd = item.usd !== undefined ? parseFloat(item.usd) : (item.currency === 'USD' ? parseFloat(item.amount || 0) : 0);
                const itemCup = item.cup !== undefined ? parseFloat(item.cup) : (item.currency === 'CUP' ? parseFloat(item.amount || 0) : 0);
                premioTotalUSD += (itemUsd || 0) * multiplicador;
                premioTotalCUP += (itemCup || 0) * multiplicador;
            }
        }

        if (premioTotalUSD > 0 || premioTotalCUP > 0) {
            const deptResult = result.departments.get(bet.bet_type);
            deptResult.won = true;
            deptResult.premioUSD += premioTotalUSD;
            deptResult.premioCUP += premioTotalCUP;
            result.departments.set(bet.bet_type, deptResult);
            userResults.set(bet.user_id, result);
        }
    }

    for (const [userId, result] of userResults.entries()) {
        let totalPremioUSD = 0;
        let totalPremioCUP = 0;

        for (const deptResult of result.departments.values()) {
            totalPremioUSD += deptResult.premioUSD;
            totalPremioCUP += deptResult.premioCUP;
        }

        if (totalPremioUSD > 0 || totalPremioCUP > 0) {
            // Obtener posible bono y moverlo al saldo principal al ganar
            let bonusMoved = 0;
            try {
                const { data: userRec } = await supabase
                    .from('users')
                    .select('usd, cup, bonus_cup')
                    .eq('telegram_id', userId)
                    .single();

                const beforeUsdVal = parseFloat(userRec?.usd) || 0;
                const beforeCupVal = parseFloat(userRec?.cup) || 0;
                const bonusVal = parseFloat(userRec?.bonus_cup) || 0;

                let newUsd = beforeUsdVal + totalPremioUSD;
                let newCup = beforeCupVal + totalPremioCUP;

                if (bonusVal > 0) {
                    newCup += bonusVal;
                    bonusMoved = bonusVal;
                }

                const updatePayload = { usd: newUsd, cup: newCup, updated_at: new Date() };
                if (bonusMoved > 0) updatePayload.bonus_cup = 0;

                await supabase
                    .from('users')
                    .update(updatePayload)
                    .eq('telegram_id', userId);

                // Guardar para notificaciones posteriores
                if (!globalThis.__bonusMovedByUser) globalThis.__bonusMovedByUser = new Map();
                globalThis.__bonusMovedByUser.set(String(userId), bonusMoved);
            } catch (e) {
                console.warn('Error moviendo bono al acreditar premio:', e?.message || e);
                const newUsd = result.beforeUsd + totalPremioUSD;
                const newCup = result.beforeCup + totalPremioCUP;
                await supabase
                    .from('users')
                    .update({ usd: newUsd, cup: newCup, updated_at: new Date() })
                    .eq('telegram_id', userId);
            }
        }

        const orderedDepartments = Array.from(result.departments.entries())
            .sort((a, b) => BET_TYPE_ORDER.indexOf(a[0]) - BET_TYPE_ORDER.indexOf(b[0]));

        for (const [betType, deptResult] of orderedDepartments) {
            const typeLabel = formatBetTypeLabel(betType);
            try {
                if (deptResult.won) {
                    const bonusMoved = (globalThis.__bonusMovedByUser && globalThis.__bonusMovedByUser.get(String(userId))) || 0;
                    const bonusMovedMsg = bonusMoved > 0 ? `\n🎁 Tu bono de bienvenida de ${bonusMoved.toFixed(2)} CUP se ha movido a tu saldo principal.` : '';
                    await bot.telegram.sendMessage(userId,
                        `🎉 <b>¡FELICIDADES! Has ganado</b>\n\n` +
                        `🔢 Número ganador: <code>${formatted}</code>\n` +
                        `🎰 ${regionMap[session.lottery]?.emoji || '🎰'} ${session.lottery} - ${session.time_slot}\n` +
                        `🏷️ Tipo: ${typeLabel}\n` +
                        `💰 Premio: ${deptResult.premioUSD > 0 ? deptResult.premioUSD.toFixed(2) + ' USD' : ''} ${deptResult.premioCUP > 0 ? deptResult.premioCUP.toFixed(2) + ' CUP' : ''}\n` +
                        `✅ El premio ya fue acreditado a tu saldo.${bonusMovedMsg}`,
                        { parse_mode: 'HTML' }
                    );
                } else {
                    await bot.telegram.sendMessage(userId,
                        `🔢 <b>Números ganadores de ${regionMap[session.lottery]?.emoji || '🎰'} ${session.lottery} (${session.date} - ${session.time_slot})</b>\n\n` +
                        `Número: <code>${formatted}</code>\n` +
                        `🏷️ Tipo: ${typeLabel}\n\n` +
                        `😔 No has ganado esta vez. ¡Sigue intentando!`,
                        { parse_mode: 'HTML' }
                    );
                }
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
    const { userId } = req.body;

    const { data: request, error: fetchError } = await supabase
        .from('deposit_requests')
        .update({ status: 'approved', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id)
        .eq('status', 'pending')
        .select()
        .single();

    if (fetchError || !request) {
        return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }

    const user = await getOrCreateUser(request.user_id);
    let newCup = parseFloat(user.cup) || 0;
    let newUsd = parseFloat(user.usd) || 0;
    let newBonus = parseFloat(user.bonus_cup) || 0;
    let bonusMovedCup = 0;

    if (request.currency === 'CUP') {
        newCup += parseFloat(request.amount);
    } else if (request.currency === 'USD') {
        newUsd += parseFloat(request.amount);
    } else {
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

    res.json({ success: true });
    (async () => {
        try {
            const creditedAmount = request.currency === 'USD'
                ? parseFloat(request.amount)
                : await convertToCUP(parseFloat(request.amount), request.currency);

            const depositedAmountText = request.amount && /[a-zA-Z]/.test(String(request.amount))
                ? String(request.amount)
                : `${request.amount} ${String(request.currency || '').toLowerCase()}`;
            const currencySymbol = request.currency === 'USD' ? '💵' : '🇨🇺';

            let text =
                `✅ <b>Depósito aprobado</b>\n\n` +
                `💰 Monto depositado: ${depositedAmountText}\n` +
                `${currencySymbol} Se acreditaron ${creditedAmount.toFixed(2)} ${request.currency === 'USD' ? 'USD' : 'CUP'} a tu saldo ${request.currency === 'USD' ? 'USD' : 'CUP'}.\n`;

            if (request.currency === 'USD') {
                text += `ℹ️ Con tu saldo USD también puedes transferir en CUP; además retirar en CUP, USDT, TRX o MLC según los métodos disponibles.\n`;
            }

            if (bonusMovedCup > 0) {
                text += `🎁 Tu bono de bienvenida de ${bonusMovedCup.toFixed(2)} CUP se ha movido a tu saldo principal.\n`;
            } else if (isFirstDeposit && newBonus > 0) {
                text += `🎁 Tu bono de bienvenida se ha movido a tu saldo principal.\n`;
            }

            text += `\n¡Gracias por confiar en nosotros!`;

            await bot.telegram.sendMessage(request.user_id,
                text,
                { parse_mode: 'HTML' }
            );

            updatePendingNotifications(`deposit_${id}`, `✅ <b>Depósito #${id} aprobado</b> por un administrador.`);
        } catch (e) {}
    })();
});

// --- Rechazar solicitud de depósito ---
app.post('/api/admin/pending-deposits/:id/reject', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;

    const { data: request, error: fetchError } = await supabase
        .from('deposit_requests')
        .update({ status: 'rejected', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id)
        .eq('status', 'pending')
        .select()
        .single();

    if (fetchError || !request) {
        return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }

    res.json({ success: true });
    (async () => {
        try {
            await bot.telegram.sendMessage(
                request.user_id,
                `❌ <b>Depósito rechazado</b>\n\n💰 Monto: ${parseFloat(request.amount)} ${String(request.currency || '').toUpperCase()}\n📌 Tu solicitud no pudo ser procesada. Si crees que esto es incorrecto, por favor contáctanos para más información.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            console.error('Error notificando rechazo de depósito:', e);
        }
        updatePendingNotifications(`deposit_${id}`, `❌ <b>Depósito #${id} rechazado</b> por un administrador.`);
    })();
});

// --- Gestor de usuarios (admin) ---
app.get('/api/admin/user/:targetUserId', requireAdmin, async (req, res) => {
    const targetUserId = parseInt(req.params.targetUserId);
    if (isNaN(targetUserId)) {
        return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    try {
        // Obtener datos del usuario
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', targetUserId)
            .single();

        if (userError || !user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        // Obtener últimas 20 apuestas
        const { data: bets } = await supabase
            .from('bets')
            .select('*')
            .eq('user_id', targetUserId)
            .order('placed_at', { ascending: false })
            .limit(20);

        // Depósitos (últimos 20)
        const { data: deposits } = await supabase
            .from('deposit_requests')
            .select('id, amount, currency, status, created_at, method_id, deposit_methods(name)')
            .eq('user_id', targetUserId)
            .order('created_at', { ascending: false })
            .limit(20);

        // Retiros (últimos 20)
        const { data: withdraws } = await supabase
            .from('withdraw_requests')
            .select('id, amount, currency, status, created_at, method_id, withdraw_methods(name)')
            .eq('user_id', targetUserId)
            .order('created_at', { ascending: false })
            .limit(20);

        // Obtener estadísticas de referidos (igual lógica que /api/user/:userId/referrals)
        const { data: referidos } = await supabase
            .from('users')
            .select('telegram_id, first_name, username')
            .eq('ref_by', targetUserId);

        let referralCount = referidos?.length || 0;
        let totalEarnedCUP = 0;
        let referredUsersList = [];

        if (referralCount > 0) {
            // Comisiones generadas
            const { data: comisiones } = await supabase
                .from('bets')
                .select('user_id, commission_amount, commission_currency')
                .eq('referrer_id', targetUserId)
                .gt('commission_amount', 0);

            // Mapa de aportes por referido
            const aportePorUsuario = new Map();
            for (const ref of referidos) {
                const nombre = ref.username
                    ? `@${ref.username}`
                    : (ref.first_name || `ID ${ref.telegram_id}`);
                aportePorUsuario.set(ref.telegram_id, { name: nombre, totalCUP: 0 });
            }

            const tasaUSD = await getExchangeRateUSD();
            for (const com of comisiones || []) {
                const uid = com.user_id;
                const amount = parseFloat(com.commission_amount) || 0;
                const amountCUP =
                    com.commission_currency === 'USD'
                        ? amount * tasaUSD
                        : amount;
                const entry = aportePorUsuario.get(uid);
                if (entry) entry.totalCUP += amountCUP;
            }

            referredUsersList = Array.from(aportePorUsuario.values())
                .sort((a, b) => b.totalCUP - a.totalCUP);

            totalEarnedCUP = referredUsersList.reduce((sum, u) => sum + u.totalCUP, 0);
        }

        res.json({
            user: {
                telegram_id: user.telegram_id,
                first_name: user.first_name,
                username: user.username,
                cup: user.cup,
                usd: user.usd,
                bonus_cup: user.bonus_cup,
                ref_by: user.ref_by,
                created_at: user.created_at,
            },
            bets: bets || [],
            referrals: {
                count: referralCount,
                totalEarnedCUP,
                list: referredUsersList,
            },
            deposits: deposits || [],
            withdraws: withdraws || []
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
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
        .update({ status: 'approved', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id)
        .eq('status', 'pending')
        .select()
        .single();

    if (fetchError || !request) {
        return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }

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

    try {
        await bot.telegram.sendMessage(request.user_id,
            `✅ <b>Retiro aprobado</b>\n\n` +
            `💰 Monto retirado: ${request.amount} ${request.currency}\n` +
            `💵 Se debitaron ${debitPlan.cupDebit.toFixed(2)} CUP y ${debitPlan.usdDebit.toFixed(2)} USD de tu saldo real.\n\n` +
            `📌 En breve los fondos serán enviados a tu cuenta.`,
            { parse_mode: 'HTML' }
        );
    } catch (e) {}

    updatePendingNotifications(`withdraw_${id}`, `✅ <b>Retiro #${id} aprobado</b> por un administrador.`);
    res.json({ success: true });
});

// --- Rechazar solicitud de retiro ---
app.post('/api/admin/pending-withdraws/:id/reject', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { userId } = req.body;

    const { data: request, error: fetchError } = await supabase
        .from('withdraw_requests')
        .update({ status: 'rejected', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id)
        .eq('status', 'pending')
        .select()
        .single();

    if (fetchError || !request) {
        return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    }

    try {
        await bot.telegram.sendMessage(request.user_id,
            `❌ <b>Retiro rechazado</b>\n\n💰 Monto: ${parseFloat(request.amount)} ${String(request.currency || '').toUpperCase()}\n📌 Tu solicitud no pudo ser procesada. Si crees que esto es incorrecto, por favor contáctanos para más información.`,
            { parse_mode: 'HTML' }
        );
    } catch (e) {}

    updatePendingNotifications(`withdraw_${id}`, `❌ <b>Retiro #${id} rechazado</b> por un administrador.`);
    res.json({ success: true });
});

// ========== NUEVO: GESTIÓN DE USUARIOS (ADMIN) ==========

// Obtener todos los usuarios (admin o user_manager) con campos extra para filtros
app.get('/api/admin/users', async (req, res) => {
    const userId = req.verifiedTelegramId || req.query.userId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'user_manager'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    try {
        // 1. Obtener todos los usuarios (incluyendo ref_by)
        const { data: users, error } = await supabase
            .from('users')
            .select('telegram_id, first_name, username, cup, usd, bonus_cup, ref_by, is_banned')
            .order('first_name', { ascending: true });

        if (error) {
            return res.status(500).json({ error: error.message });
        }

        // 2. Obtener IDs de usuarios que tienen al menos una apuesta
        const { data: betsData } = await supabase
            .from('bets')
            .select('user_id');

        const usersWithBets = new Set((betsData || []).map(b => b.user_id));

        // 3. Contar referidos por cada referrer
        const { data: referrals } = await supabase
            .from('users')
            .select('ref_by');
        const referralCounts = new Map();
        (referrals || []).forEach(r => {
            if (r.ref_by) {
                referralCounts.set(r.ref_by, (referralCounts.get(r.ref_by) || 0) + 1);
            }
        });

        // 4. Construir respuesta con los campos extra
        const enrichedUsers = (users || []).map(u => ({
            telegram_id: u.telegram_id,
            first_name: u.first_name,
            username: u.username,
            cup: u.cup,
            usd: u.usd,
            bonus_cup: u.bonus_cup,
            is_referred: !!u.ref_by,
            has_bets: usersWithBets.has(u.telegram_id),
            referral_count: referralCounts.get(u.telegram_id) || 0,
            is_banned: !!u.is_banned
        }));

        res.json(enrichedUsers);
    } catch (e) {
        console.error('Error obteniendo usuarios:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Editar saldo de un usuario (admin o user_manager)
app.put('/api/admin/users/:telegramId/balance', async (req, res) => {
    const userId = req.verifiedTelegramId || req.body.userId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'user_manager'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const telegramId = parseInt(req.params.telegramId);
    if (isNaN(telegramId)) {
        return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    let { cup, usd, bonus_cup } = req.body;
    cup = parseFloat(cup) || 0;
    usd = parseFloat(usd) || 0;
    bonus_cup = parseFloat(bonus_cup) || 0;

    if (cup < 0 || usd < 0 || bonus_cup < 0) {
        return res.status(400).json({ error: 'Los saldos no pueden ser negativos' });
    }

    try {
        // Obtener usuario actual para verificar migración del bono
        const { data: user, error: userError } = await supabase
            .from('users')
            .select('cup, usd, bonus_cup')
            .eq('telegram_id', telegramId)
            .single();

        if (userError || !user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const oldCupVal = parseFloat(user.cup) || 0;
        const oldUsdVal = parseFloat(user.usd) || 0;
        const oldBonusVal = parseFloat(user.bonus_cup) || 0;
        const _diffCup = cup - oldCupVal;
        const _diffUsd = usd - oldUsdVal;

        // Validar: no agregar bono a usuario con saldo principal
        if (bonus_cup > oldBonusVal && (oldCupVal > 0 || oldUsdVal > 0)) {
            const razon = oldCupVal > 0 && oldUsdVal > 0 ? 'saldo principal y USD'
                : oldCupVal > 0 ? 'saldo principal'
                : 'saldo USD';
            return res.status(400).json({ error: `❌ Usuario con ${razon}. No es posible asignarle bonificación.` });
        }

        // Validar: usuario con bono necesita mínimo de depósito para agregar CUP/USD
        if (oldBonusVal > 0) {
            const minDepCUP = await getMinDepositCUP();
            const minDepUSD = await getMinDepositUSD();
            if (_diffCup > 0.001 && _diffCup < minDepCUP) {
                return res.status(400).json({ error: `❌ El monto mínimo para agregar CUP a un usuario con bonificación es ${minDepCUP.toFixed(2)} CUP.` });
            }
            if (_diffUsd > 0.001 && _diffUsd < minDepUSD) {
                return res.status(400).json({ error: `❌ El monto mínimo para agregar USD a un usuario con bonificación es ${minDepUSD.toFixed(2)} USD.` });
            }
        }

        // Lógica de migración de bono
        const minDepositCUP = await getMinDepositCUP();
        const minDepositUSD = await getMinDepositUSD();
        const rateUSD = await getExchangeRateUSD();
        const totalEquivalentCUP = cup + (usd * rateUSD) + bonus_cup;

        let finalCup = cup;
        let finalUsd = usd;
        let finalBonus = bonus_cup;

        let existingBonusMigrated = false;

        // Si el usuario tiene bono existente y admin agrega saldo principal >= mínimo, migrar bono
        if (oldBonusVal > 0) {
            const addedCup = cup - oldCupVal;
            const addedUsd = usd - oldUsdVal;
            const addingEnoughCup = addedCup >= minDepositCUP && addedCup > 0.001;
            const addingEnoughUsd = addedUsd >= minDepositUSD && addedUsd > 0.001;
            if (addingEnoughCup || addingEnoughUsd) {
                finalCup += oldBonusVal;
                finalBonus = 0;
                existingBonusMigrated = true;
            }
        }

        // Si el admin asignó un bono nuevo y cumple el umbral, migrar a CUP
        if (!existingBonusMigrated && bonus_cup > 0 && totalEquivalentCUP >= minDepositCUP) {
            finalCup += bonus_cup;
            finalBonus = 0;
        }

        const { error: updateError } = await supabase
            .from('users')
            .update({
                cup: finalCup,
                usd: finalUsd,
                bonus_cup: finalBonus,
                updated_at: new Date()
            })
            .eq('telegram_id', telegramId);

        if (updateError) {
            return res.status(500).json({ error: updateError.message });
        }

        // ========== NOTIFICACIONES AL USUARIO ==========
        const oldCup = parseFloat(user.cup) || 0;
        const oldUsd = parseFloat(user.usd) || 0;
        const oldBonus = parseFloat(user.bonus_cup) || 0;

        const adminHeader = `<b>${escapeHTML(botInfo.first_name || botInfo.username || '4pu3$t4$ Qva®')}</b> — ADMIN:\n\n`;

        // Diferencia de lo que el admin realmente solicitó (antes de migración)
        const diffCupReq = cup - oldCup;
        const diffUsdReq = usd - oldUsd;
        const diffBonusReq = bonus_cup - oldBonus;
        const adminAddedBonus = diffBonusReq > 0.001;
        const bonusMigrated = (adminAddedBonus && finalBonus === 0) || existingBonusMigrated;

        // 1. Si el admin añadió bono y migró a CUP
        if (bonusMigrated) {
            const cupUsdParts = [];
            if (Math.abs(diffCupReq) > 0.001) {
                const esRestaTotal = diffCupReq < 0 && Math.abs(Math.abs(diffCupReq) - oldCup) < 0.001;
                const verbo = diffCupReq > 0 ? 'sumados' : (esRestaTotal ? 'restados los' : 'restados');
                const prep = diffCupReq > 0 ? 'a' : 'de';
                cupUsdParts.push(`${verbo} ${Math.abs(diffCupReq).toFixed(2)} CUP ${prep} tu saldo principal`);
            }
            if (Math.abs(diffUsdReq) > 0.001) {
                const esRestaTotal = diffUsdReq < 0 && Math.abs(Math.abs(diffUsdReq) - oldUsd) < 0.001;
                const verbo = diffUsdReq > 0 ? 'sumados' : (esRestaTotal ? 'restados los' : 'restados');
                const prep = diffUsdReq > 0 ? 'a' : 'de';
                cupUsdParts.push(`${verbo} ${Math.abs(diffUsdReq).toFixed(2)} USD ${prep} tu saldo USD`);
            }

            let msg;
            if (cupUsdParts.length > 0) {
                const movido = Math.abs(diffUsdReq) <= 0.001 ? 'al mismo' : 'a tu saldo principal';
                msg = `⚠️ Han sido ${cupUsdParts.join(' y ')}. Tu bono de bienvenida actual se ha movido ${movido}.`;
            } else {
                const esRestaTotal = diffBonusReq < 0 && Math.abs(Math.abs(diffBonusReq) - oldBonus) < 0.001;
                const verbo = diffBonusReq > 0 ? 'sumados' : (esRestaTotal ? 'restados los' : 'restados');
                const prep = diffBonusReq > 0 ? 'a' : 'de';
                msg = `⚠️ Han sido ${verbo} ${Math.abs(diffBonusReq).toFixed(2)} CUP ${prep} tu bono de bienvenida actual, este se ha movido a tu saldo principal.`;
            }

            try {
                await bot.telegram.sendMessage(telegramId,
                    adminHeader + msg + ` Si crees que esto es incorrecto, por favor, contáctanos.`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {}
        }
        // 2. Cambio en el bono (aumento o reducción) que NO migró
        else if (Math.abs(diffBonusReq) > 0.001) {
            const esRestaTotal = diffBonusReq < 0 && Math.abs(Math.abs(diffBonusReq) - oldBonus) < 0.001;
            const verbo = diffBonusReq > 0 ? 'sumados' : (esRestaTotal ? 'restados los' : 'restados');
            const prep = diffBonusReq > 0 ? 'a' : 'de';
            try {
                await bot.telegram.sendMessage(telegramId,
                    adminHeader + `⚠️ Han sido ${verbo} ${Math.abs(diffBonusReq).toFixed(2)} CUP ${prep} tu bono de bienvenida actual. Si crees que esto es incorrecto, por favor, contáctanos.`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {}
        }

        // 3. Cambios en CUP o USD (solo si NO hubo migración de bono, para evitar redundancia)
        if (!bonusMigrated && (Math.abs(diffCupReq) > 0.001 || Math.abs(diffUsdReq) > 0.001)) {
            const partes = [];
            if (Math.abs(diffCupReq) > 0.001) {
                const esRestaTotal = diffCupReq < 0 && Math.abs(Math.abs(diffCupReq) - oldCup) < 0.001;
                const verbo = diffCupReq > 0 ? 'sumados' : (esRestaTotal ? 'restados los' : 'restados');
                const prep = diffCupReq > 0 ? 'a' : 'de';
                partes.push(`${verbo} ${Math.abs(diffCupReq).toFixed(2)} CUP ${prep} tu saldo principal`);
            }
            if (Math.abs(diffUsdReq) > 0.001) {
                const esRestaTotal = diffUsdReq < 0 && Math.abs(Math.abs(diffUsdReq) - oldUsd) < 0.001;
                const verbo = diffUsdReq > 0 ? 'sumados' : (esRestaTotal ? 'restados los' : 'restados');
                const prep = diffUsdReq > 0 ? 'a' : 'de';
                partes.push(`${verbo} ${Math.abs(diffUsdReq).toFixed(2)} USD ${prep} tu saldo USD`);
            }

            const mensaje = adminHeader + `⚠️ Han sido ${partes.join(' y ')}. Si crees que esto es incorrecto, por favor, contáctanos.`;
            try {
                await bot.telegram.sendMessage(telegramId, mensaje, { parse_mode: 'HTML' });
            } catch (e) {}
        }

        res.json({ success: true, cup: finalCup, usd: finalUsd, bonus_cup: finalBonus });
    } catch (e) {
        console.error('Error editando balance de usuario:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Banear usuario permanentemente
app.post('/api/admin/users/:telegramId/ban', async (req, res) => {
    const userId = req.verifiedTelegramId || req.body.userId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'user_manager'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const telegramId = parseInt(req.params.telegramId);
    if (isNaN(telegramId)) {
        return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    try {
        const { data, error } = await supabase
            .from('users')
            .update({ is_banned: true, updated_at: new Date().toISOString() })
            .eq('telegram_id', telegramId)
            .select();

        if (error) {
            return res.status(500).json({ error: 'No se pudo banear al usuario. Verifica que la columna is_banned exista en la tabla users.' });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ success: true });

        const bannedUser = data[0];
        if (bannedUser && bannedUser.ref_by) {
            (async () => {
                try {
                    const referrerId = bannedUser.ref_by;
                    const userName = bannedUser.first_name || bannedUser.username || 'Usuario';
                    const referralRate = await getReferralCommissionRate();

                    const { data: openSessions } = await supabase
                        .from('lottery_sessions')
                        .select('id')
                        .eq('status', 'open');
                    const openSessionIds = (openSessions || []).map(s => s.id);

                    if (openSessionIds.length > 0) {
                        const { data: activeBets } = await supabase
                            .from('bets')
                            .select('cost_cup, cost_usd')
                            .eq('user_id', telegramId)
                            .in('session_id', openSessionIds);

                        if (activeBets && activeBets.length > 0) {
                            const usdRate = await getExchangeRateUSD();
                            let totalBetCUP = 0;
                            for (const bet of activeBets) {
                                totalBetCUP += (parseFloat(bet.cost_cup) || 0) + ((parseFloat(bet.cost_usd) || 0) * usdRate);
                            }
                            const deduction = totalBetCUP * referralRate;

                            if (deduction > 0) {
                                const { data: referrer } = await supabase
                                    .from('users')
                                    .select('cup')
                                    .eq('telegram_id', referrerId)
                                    .single();

                                if (referrer) {
                                    const newCup = Math.max(0, (parseFloat(referrer.cup) || 0) - deduction);
                                    await supabase
                                        .from('users')
                                        .update({ cup: newCup, updated_at: new Date() })
                                        .eq('telegram_id', referrerId);

                                    const percent = Number.isInteger(referralRate * 100) ? (referralRate * 100).toString() : (referralRate * 100).toFixed(2);
                                    await bot.telegram.sendMessage(referrerId,
                                        `⚠️ Tu referido ${escapeHTML(userName)} acaba de ser baneado. Ha sido restado de tu saldo actual el ${percent}% del monto apostado en su jugada activa.`,
                                        { parse_mode: 'HTML' }
                                    ).catch(e => console.error('Error notificando al referidor:', e));
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error('Error al procesar deducción por referido baneado:', e);
                }
            })();
        }
    } catch (e) {
        console.error('Error baneando usuario:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Desbanear usuario
app.post('/api/admin/users/:telegramId/unban', async (req, res) => {
    const userId = req.verifiedTelegramId || req.body.userId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'user_manager'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const telegramId = parseInt(req.params.telegramId);
    if (isNaN(telegramId)) {
        return res.status(400).json({ error: 'ID de usuario inválido' });
    }

    try {
        const { data, error } = await supabase
            .from('users')
            .update({ is_banned: false, updated_at: new Date().toISOString() })
            .eq('telegram_id', telegramId)
            .select();

        if (error) {
            return res.status(500).json({ error: 'No se pudo desbanear al usuario.' });
        }

        if (!data || data.length === 0) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({ success: true });
    } catch (e) {
        console.error('Error desbaneando usuario:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Reiniciar usuario (lo deja como nuevo, con el bono de bienvenida actual)
app.post('/api/admin/users/:telegramId/reset', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'user_manager'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const telegramId = parseInt(req.params.telegramId);
    if (isNaN(telegramId)) {
        return res.status(400).json({ error: 'ID de usuario inválido' });
    }
    try {
        const { data: user, error: findError } = await supabase
            .from('users')
            .select('telegram_id, first_name, username, ref_by')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (findError || !user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const userRefBy = user.ref_by;
        const userFirstName = user.first_name;
        const userUsername = user.username;

        const { error: deleteError } = await supabase
            .from('users')
            .delete()
            .eq('telegram_id', telegramId);

        if (deleteError) {
            return res.status(500).json({ error: 'No se pudo eliminar al usuario.' });
        }

        res.json({ success: true, message: 'Usuario eliminado. Podrá registrarse de nuevo como nuevo usuario.' });

        if (userRefBy) {
            (async () => {
                try {
                    const referrerId = userRefBy;
                    const userName = userFirstName || userUsername || 'Usuario';
                    const referralRate = await getReferralCommissionRate();

                    const { data: openSessions } = await supabase
                        .from('lottery_sessions')
                        .select('id')
                        .eq('status', 'open');
                    const openSessionIds = (openSessions || []).map(s => s.id);

                    if (openSessionIds.length > 0) {
                        const { data: activeBets } = await supabase
                            .from('bets')
                            .select('cost_cup, cost_usd')
                            .eq('user_id', telegramId)
                            .in('session_id', openSessionIds);

                        if (activeBets && activeBets.length > 0) {
                            const usdRate = await getExchangeRateUSD();
                            let totalBetCUP = 0;
                            for (const bet of activeBets) {
                                totalBetCUP += (parseFloat(bet.cost_cup) || 0) + ((parseFloat(bet.cost_usd) || 0) * usdRate);
                            }
                            const deduction = totalBetCUP * referralRate;

                            if (deduction > 0) {
                                const { data: referrer } = await supabase
                                    .from('users')
                                    .select('cup')
                                    .eq('telegram_id', referrerId)
                                    .single();

                                if (referrer) {
                                    const newCup = Math.max(0, (parseFloat(referrer.cup) || 0) - deduction);
                                    await supabase
                                        .from('users')
                                        .update({ cup: newCup, updated_at: new Date() })
                                        .eq('telegram_id', referrerId);

                                    const percent = Number.isInteger(referralRate * 100) ? (referralRate * 100).toString() : (referralRate * 100).toFixed(2);
                                    await bot.telegram.sendMessage(referrerId,
                                        `⚠️ Tu referido ${escapeHTML(userName)} acaba de ser eliminado. Ha sido restado de tu saldo actual el ${percent}% del monto apostado en su jugada activa.`,
                                        { parse_mode: 'HTML' }
                                    ).catch(e => console.error('Error notificando al referidor:', e));
                                }
                            }
                        }
                    }
                } catch (e) {
                    console.error('Error al procesar deducción por referido eliminado:', e);
                }
            })();
        }
    } catch (e) {
        console.error('Error eliminando usuario:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ========== ENDPOINTS DE GESTIÓN DE ROLES (solo super admin) ==========

// Obtener todos los roles asignados
app.get('/api/admin/admin-roles', requireAdmin, async (req, res) => {
    try {
        const { data } = await supabase.from('admin_roles').select('*').order('telegram_id');
        const enriched = [];
        for (const row of data || []) {
            const { data: user } = await supabase
                .from('users')
                .select('first_name, username')
                .eq('telegram_id', row.telegram_id)
                .maybeSingle();
            enriched.push({
                telegram_id: row.telegram_id,
                role: row.role,
                created_at: row.created_at,
                assigned_by: row.assigned_by,
                user_name: user?.first_name || 'Desconocido',
                username: user?.username
            });
        }
        res.json(enriched);
    } catch (e) {
        console.error('Error obteniendo roles:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Obtener roles de un usuario específico
app.get('/api/admin/admin-roles/:telegramId', requireAdmin, async (req, res) => {
    try {
        const telegramId = parseInt(req.params.telegramId);
        const { data } = await supabase
            .from('admin_roles')
            .select('role')
            .eq('telegram_id', telegramId);
        const roles = (data || []).map(r => r.role);
        res.json({ telegram_id: telegramId, roles });
    } catch (e) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Asignar roles a un usuario (reemplaza todos los roles existentes)
app.put('/api/admin/admin-roles/:telegramId', requireAdmin, async (req, res) => {
    try {
        const telegramId = parseInt(req.params.telegramId);
        const { roles } = req.body; // array de strings: ['withdraw_approver', 'deposit_approver', 'schedule_manager']
        const uid = parseInt(req.verifiedTelegramId || req.body.userId);

        if (!Array.isArray(roles)) {
            return res.status(400).json({ error: 'roles debe ser un array' });
        }

        const validRoles = ['deposit_approver', 'withdraw_approver', 'schedule_manager', 'user_manager'];
        for (const role of roles) {
            if (!validRoles.includes(role)) {
                return res.status(400).json({ error: `Rol inválido: ${role}` });
            }
        }

        // Eliminar todos los roles existentes del usuario
        await supabase.from('admin_roles').delete().eq('telegram_id', telegramId);

        // Insertar los nuevos roles
        if (roles.length > 0) {
            const inserts = roles.map(role => ({
                telegram_id: telegramId,
                role,
                assigned_by: uid
            }));
            const { error } = await supabase.from('admin_roles').insert(inserts);
            if (error) return res.status(500).json({ error: error.message });
        }

        // Refrescar caché de backend y del bot
        await refreshRolesCache();
        if (bot && typeof bot.refreshBotRolesCache === 'function') bot.refreshBotRolesCache();

        res.json({ success: true, telegram_id: telegramId, roles });
    } catch (e) {
        console.error('Error asignando roles:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Obtener mis propios roles (público autenticado)
app.get('/api/my-roles', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.json({ roles: [] });
    const roles = await getUserRoles(userId);
    res.json({ roles, isSuperAdmin: isAdmin(userId) });
});

// ========== ESTADÍSTICAS DE SUBADMINS (solo super admin) ==========

// Resumen agregado de todos los subadmins
app.get('/api/admin/subadmin-stats', requireAdmin, async (req, res) => {
    try {
        const { data: roleData } = await supabase.from('admin_roles').select('telegram_id');
        const subadminIds = [...new Set((roleData || []).map(r => Number(r.telegram_id)))];

        if (subadminIds.length === 0) return res.json([]);

        const { data: users } = await supabase
            .from('users')
            .select('telegram_id, first_name, username')
            .in('telegram_id', subadminIds);
        const userMap = {};
        for (const u of users || []) userMap[Number(u.telegram_id)] = u;

        const { data: allDeposits } = await supabase
            .from('deposit_requests')
            .select('processed_by, amount, currency')
            .eq('status', 'approved')
            .in('processed_by', subadminIds);

        const { data: allWithdrawals } = await supabase
            .from('withdraw_requests')
            .select('processed_by, amount, currency')
            .eq('status', 'approved')
            .in('processed_by', subadminIds);

        const rates = await getExchangeRates();
        const result = [];

        for (const id of subadminIds) {
            const userDeposits = (allDeposits || []).filter(d => Number(d.processed_by) === id);
            const userWithdrawals = (allWithdrawals || []).filter(w => Number(w.processed_by) === id);

            let depCount = 0, depCUP = 0, depUSD = 0;
            for (const d of userDeposits) {
                depCount++;
                const amt = parseFloat(d.amount) || 0;
                if (d.currency === 'USD') depUSD += amt;
                else if (d.currency === 'CUP') depCUP += amt;
                else depCUP += amt * (rates[d.currency.toLowerCase() === 'usdt' ? 'rate_usdt' : d.currency.toLowerCase() === 'trx' ? 'rate_trx' : 'rate_mlc'] || 0);
            }

            let wdCount = 0, wdCUP = 0, wdUSD = 0;
            for (const w of userWithdrawals) {
                wdCount++;
                const amt = parseFloat(w.amount) || 0;
                if (w.currency === 'USD') wdUSD += amt;
                else if (w.currency === 'CUP') wdCUP += amt;
                else wdCUP += amt * (rates[w.currency.toLowerCase() === 'usdt' ? 'rate_usdt' : w.currency.toLowerCase() === 'trx' ? 'rate_trx' : 'rate_mlc'] || 0);
            }

            const user = userMap[id] || {};
            result.push({
                telegram_id: id,
                first_name: user.first_name || 'Desconocido',
                username: user.username,
                deposit_count: depCount,
                deposit_total_cup: Math.round(depCUP * 100) / 100,
                deposit_total_usd: Math.round(depUSD * 100) / 100,
                withdraw_count: wdCount,
                withdraw_total_cup: Math.round(wdCUP * 100) / 100,
                withdraw_total_usd: Math.round(wdUSD * 100) / 100
            });
        }

        result.sort((a, b) => a.first_name.localeCompare(b.first_name));
        res.json(result);
    } catch (e) {
        console.error('Error obteniendo stats de subadmins:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Detalle individual de un subadmin
app.get('/api/admin/subadmin-stats/:telegramId', requireAdmin, async (req, res) => {
    try {
        const telegramId = parseInt(req.params.telegramId);
        if (isNaN(telegramId)) return res.status(400).json({ error: 'ID inválido' });

        const { start_date, end_date, start_time, end_time } = req.query;

        let depQuery = supabase.from('deposit_requests')
            .select(`id, user_id, amount, currency, created_at, processed_at,
                users (first_name, username)`)
            .eq('processed_by', telegramId)
            .eq('status', 'approved');

        let wdQuery = supabase.from('withdraw_requests')
            .select(`id, user_id, amount, currency, created_at, processed_at,
                users (first_name, username)`)
            .eq('processed_by', telegramId)
            .eq('status', 'approved');

        if (start_date && end_date) {
            const startISO = `${start_date}T00:00:00.000Z`;
            const endISO = `${end_date}T23:59:59.999Z`;
            depQuery = depQuery.gte('processed_at', startISO).lte('processed_at', endISO);
            wdQuery = wdQuery.gte('processed_at', startISO).lte('processed_at', endISO);
        } else if (start_date) {
            const startISO = `${start_date}T00:00:00.000Z`;
            const endISO = `${start_date}T23:59:59.999Z`;
            depQuery = depQuery.gte('processed_at', startISO).lte('processed_at', endISO);
            wdQuery = wdQuery.gte('processed_at', startISO).lte('processed_at', endISO);
        } else if (end_date) {
            const startISO = `${end_date}T00:00:00.000Z`;
            const endISO = `${end_date}T23:59:59.999Z`;
            depQuery = depQuery.gte('processed_at', startISO).lte('processed_at', endISO);
            wdQuery = wdQuery.gte('processed_at', startISO).lte('processed_at', endISO);
        }

        depQuery = depQuery.order('processed_at', { ascending: false }).limit(100);
        wdQuery = wdQuery.order('processed_at', { ascending: false }).limit(100);

        // Rejected queries
        let depRejQuery = supabase.from('deposit_requests')
            .select(`id, user_id, amount, currency, created_at, processed_at,
                users (first_name, username)`)
            .eq('processed_by', telegramId)
            .eq('status', 'rejected');

        let wdRejQuery = supabase.from('withdraw_requests')
            .select(`id, user_id, amount, currency, created_at, processed_at,
                users (first_name, username)`)
            .eq('processed_by', telegramId)
            .eq('status', 'rejected');

        if (start_date && end_date) {
            const startISO = `${start_date}T00:00:00.000Z`;
            const endISO = `${end_date}T23:59:59.999Z`;
            depRejQuery = depRejQuery.gte('processed_at', startISO).lte('processed_at', endISO);
            wdRejQuery = wdRejQuery.gte('processed_at', startISO).lte('processed_at', endISO);
        } else if (start_date) {
            const startISO = `${start_date}T00:00:00.000Z`;
            const endISO = `${start_date}T23:59:59.999Z`;
            depRejQuery = depRejQuery.gte('processed_at', startISO).lte('processed_at', endISO);
            wdRejQuery = wdRejQuery.gte('processed_at', startISO).lte('processed_at', endISO);
        } else if (end_date) {
            const startISO = `${end_date}T00:00:00.000Z`;
            const endISO = `${end_date}T23:59:59.999Z`;
            depRejQuery = depRejQuery.gte('processed_at', startISO).lte('processed_at', endISO);
            wdRejQuery = wdRejQuery.gte('processed_at', startISO).lte('processed_at', endISO);
        }

        depRejQuery = depRejQuery.order('processed_at', { ascending: false }).limit(100);
        wdRejQuery = wdRejQuery.order('processed_at', { ascending: false }).limit(100);

        const [depositsRes, withdrawalsRes, depRejRes, wdRejRes, userRes] = await Promise.all([
            depQuery,
            wdQuery,
            depRejQuery,
            wdRejQuery,
            supabase.from('users')
                .select('first_name, username')
                .eq('telegram_id', telegramId)
                .maybeSingle()
        ]);

        const rates = await getExchangeRates();
        const rateMap = { cup: 1, usd: rates.rate, usdt: rates.rate_usdt, trx: rates.rate_trx, mlc: rates.rate_mlc };

        let formattedDeposits = (depositsRes.data || []).map(d => ({
            id: d.id,
            user_id: d.user_id,
            user_name: d.users?.first_name || 'Desconocido',
            username: d.users?.username,
            amount: parseFloat(d.amount) || 0,
            amount_cup: Math.round(((d.currency === 'CUP' ? (parseFloat(d.amount) || 0) : (parseFloat(d.amount) || 0) * (rateMap[d.currency?.toLowerCase()] || 0))) * 100) / 100,
            currency: d.currency,
            processed_at: d.processed_at
        }));

        let formattedWithdrawals = (withdrawalsRes.data || []).map(w => ({
            id: w.id,
            user_id: w.user_id,
            user_name: w.users?.first_name || 'Desconocido',
            username: w.users?.username,
            amount: parseFloat(w.amount) || 0,
            amount_cup: Math.round(((w.currency === 'CUP' ? (parseFloat(w.amount) || 0) : (parseFloat(w.amount) || 0) * (rateMap[w.currency?.toLowerCase()] || 0))) * 100) / 100,
            currency: w.currency,
            processed_at: w.processed_at
        }));

        let rejectedDeposits = (depRejRes.data || []).map(d => ({
            id: d.id,
            user_id: d.user_id,
            user_name: d.users?.first_name || 'Desconocido',
            username: d.users?.username,
            amount: parseFloat(d.amount) || 0,
            amount_cup: Math.round(((d.currency === 'CUP' ? (parseFloat(d.amount) || 0) : (parseFloat(d.amount) || 0) * (rateMap[d.currency?.toLowerCase()] || 0))) * 100) / 100,
            currency: d.currency,
            processed_at: d.processed_at,
            type: 'deposito'
        }));

        let rejectedWithdrawals = (wdRejRes.data || []).map(w => ({
            id: w.id,
            user_id: w.user_id,
            user_name: w.users?.first_name || 'Desconocido',
            username: w.users?.username,
            amount: parseFloat(w.amount) || 0,
            amount_cup: Math.round(((w.currency === 'CUP' ? (parseFloat(w.amount) || 0) : (parseFloat(w.amount) || 0) * (rateMap[w.currency?.toLowerCase()] || 0))) * 100) / 100,
            currency: w.currency,
            processed_at: w.processed_at,
            type: 'retiro'
        }));

        // Apply time filter in memory (converts Cuba time to UTC for DB comparison)
        function filterByTime(items, startTime, endTime) {
            if (!startTime && !endTime) return items;
            let startUTC = null, endUTC = null;
            if (startTime) {
                const m = moment.tz(startTime, 'HH:mm', TIMEZONE).utc();
                startUTC = m.hours() * 60 + m.minutes();
            }
            if (endTime) {
                const m = moment.tz(endTime, 'HH:mm', TIMEZONE).utc();
                endUTC = m.hours() * 60 + m.minutes();
            }
            return items.filter(item => {
                if (!item.processed_at) return false;
                const d = new Date(item.processed_at);
                const totalMinutes = d.getUTCHours() * 60 + d.getUTCMinutes();
                if (startUTC !== null && totalMinutes < startUTC) return false;
                if (endUTC !== null && totalMinutes > endUTC) return false;
                return true;
            });
        }

        formattedDeposits = filterByTime(formattedDeposits, start_time, end_time);
        formattedWithdrawals = filterByTime(formattedWithdrawals, start_time, end_time);
        rejectedDeposits = filterByTime(rejectedDeposits, start_time, end_time);
        rejectedWithdrawals = filterByTime(rejectedWithdrawals, start_time, end_time);

        // Combine rejected items sorted by processed_at
        const allRejected = [...rejectedDeposits, ...rejectedWithdrawals].sort((a, b) => {
            const da = a.processed_at ? new Date(a.processed_at) : new Date(0);
            const db = b.processed_at ? new Date(b.processed_at) : new Date(0);
            return db - da;
        });

        // Totals
        const totalDepositAmount = formattedDeposits.reduce((sum, d) => sum + d.amount, 0);
        const totalDepositCUP = formattedDeposits.reduce((sum, d) => sum + d.amount_cup, 0);
        const totalWithdrawAmount = formattedWithdrawals.reduce((sum, w) => sum + w.amount, 0);
        const totalWithdrawCUP = formattedWithdrawals.reduce((sum, w) => sum + w.amount_cup, 0);

        // Separate CUP and USD totals
        const depositCupTotal = formattedDeposits.filter(d => d.currency === 'CUP').reduce((sum, d) => sum + d.amount, 0);
        const depositUsdTotal = formattedDeposits.filter(d => d.currency === 'USD').reduce((sum, d) => sum + d.amount, 0);
        const withdrawCupTotal = formattedWithdrawals.filter(w => w.currency === 'CUP').reduce((sum, w) => sum + w.amount, 0);
        const withdrawUsdTotal = formattedWithdrawals.filter(w => w.currency === 'USD').reduce((sum, w) => sum + w.amount, 0);

        res.json({
            telegram_id: telegramId,
            first_name: userRes.data?.first_name || 'Desconocido',
            username: userRes.data?.username,
            deposits: formattedDeposits,
            withdrawals: formattedWithdrawals,
            rejected: allRejected,
            totals: {
                deposit_count: formattedDeposits.length,
                deposit_amount_total: Math.round(totalDepositAmount * 100) / 100,
                deposit_cup_total: Math.round(totalDepositCUP * 100) / 100,
                deposit_cup: Math.round(depositCupTotal * 100) / 100,
                deposit_usd: Math.round(depositUsdTotal * 100) / 100,
                withdraw_count: formattedWithdrawals.length,
                withdraw_amount_total: Math.round(totalWithdrawAmount * 100) / 100,
                withdraw_cup_total: Math.round(totalWithdrawCUP * 100) / 100,
                withdraw_cup: Math.round(withdrawCupTotal * 100) / 100,
                withdraw_usd: Math.round(withdrawUsdTotal * 100) / 100
            }
        });
    } catch (e) {
        console.error('Error obteniendo detalle de subadmin:', e);
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// ========== ENDPOINTS ACCESIBLES POR ROLE-BASED USERS ==========

// Obtener solicitudes de depósito pendientes (deposit_approver o admin)
app.get('/api/admin/pending-deposits-role', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'deposit_approver'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const { data, error } = await supabase
        .from('deposit_requests')
        .select(`
            id, user_id, amount, currency, screenshot_url, status, created_at,
            users (first_name, username),
            deposit_methods (name, card, confirm)
        `)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const formatted = (data || []).map(d => ({
        id: d.id, user_id: d.user_id, user_name: d.users?.first_name || 'Desconocido',
        username: d.users?.username, amount: d.amount, currency: d.currency,
        screenshot_url: d.screenshot_url, method_name: d.deposit_methods?.name,
        method_card: d.deposit_methods?.card, method_confirm: d.deposit_methods?.confirm,
        created_at: d.created_at
    }));
    res.json(formatted);
});

// Aprobar depósito (deposit_approver o admin)
app.post('/api/admin/pending-deposits-role/:id/approve', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'deposit_approver'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const { id } = req.params;
    const { data: request, error: fetchError } = await supabase
        .from('deposit_requests').update({ status: 'approved', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id).eq('status', 'pending').select().single();
    if (fetchError || !request) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });

    const { data: user } = await supabase
        .from('users')
        .select('cup, usd, bonus_cup')
        .eq('telegram_id', request.user_id)
        .single();

    let newCup = parseFloat(user?.cup) || 0;
    let newUsd = parseFloat(user?.usd) || 0;
    let bonusCup = parseFloat(user?.bonus_cup) || 0;
    let bonusMovedCup = 0;

    if (request.currency === 'CUP') newCup += parseFloat(request.amount);
    else if (request.currency === 'USD') newUsd += parseFloat(request.amount);
    else { const cupAmount = await convertToCUP(parseFloat(request.amount), request.currency); newCup += cupAmount; }

    if (bonusCup > 0) {
        const { data: prevApproved } = await supabase.from('deposit_requests').select('id').eq('user_id', request.user_id).eq('status', 'approved').neq('id', parseInt(id)).limit(1);
        if (!(prevApproved && prevApproved.length > 0)) {
            newCup += bonusCup;
            bonusMovedCup = bonusCup;
            bonusCup = 0;
        }
    }

    await supabase.from('users').update({ cup: newCup, usd: newUsd, bonus_cup: bonusCup, updated_at: new Date() }).eq('telegram_id', request.user_id);

    res.json({ success: true });
    (async () => {
        try {
            const creditedAmount = request.currency === 'USD' ? parseFloat(request.amount) : await convertToCUP(parseFloat(request.amount), request.currency);
            const depositedAmountText = request.amount && /[a-zA-Z]/.test(String(request.amount))
                ? String(request.amount)
                : `${request.amount} ${String(request.currency || '').toLowerCase()}`;
            const currencySymbol = request.currency === 'USD' ? '💵' : '🇨🇺';
            let text = `✅ <b>Depósito aprobado</b>\n\n💰 Monto depositado: ${depositedAmountText}\n${currencySymbol} Se acreditaron ${creditedAmount.toFixed(2)} ${request.currency === 'USD' ? 'USD' : 'CUP'} a tu saldo ${request.currency === 'USD' ? 'USD' : 'CUP'}.\n`;
            if (request.currency === 'USD') {
                text += `ℹ️ Con tu saldo USD también puedes transferir en CUP; además retirar en CUP, USDT, TRX o MLC según los métodos disponibles.\n`;
            }
            if (bonusMovedCup > 0) {
                text += `🎁 Tu bono de bienvenida de ${bonusMovedCup.toFixed(2)} CUP se ha movido a tu saldo principal.\n`;
            }
            text += `\n\n¡Gracias por confiar en nosotros!`;
            if (bot && bot.telegram) await bot.telegram.sendMessage(request.user_id, text, { parse_mode: 'HTML' });
            updatePendingNotifications(`deposit_${id}`, `✅ <b>Depósito #${id} aprobado</b> por un administrador.`);
        } catch (e) {}
    })();
});

// Rechazar depósito (deposit_approver o admin)
app.post('/api/admin/pending-deposits-role/:id/reject', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'deposit_approver'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const { id } = req.params;
    const { data: request, error: fetchError } = await supabase
        .from('deposit_requests').update({ status: 'rejected', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id).eq('status', 'pending').select().single();
    if (fetchError || !request) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    res.json({ success: true });
    (async () => {
        try {
            if (bot && bot.telegram) await bot.telegram.sendMessage(request.user_id, `❌ <b>Depósito rechazado</b>\n\n💰 Monto: ${parseFloat(request.amount)} ${String(request.currency || '').toUpperCase()}\n📌 Tu solicitud no pudo ser procesada. Si crees que esto es incorrecto, por favor contáctanos para más información.`, { parse_mode: 'HTML' });
        } catch (e) {}
        updatePendingNotifications(`deposit_${id}`, `❌ <b>Depósito #${id} rechazado</b> por un administrador.`);
    })();
});

// Obtener solicitudes de retiro pendientes (withdraw_approver o admin)
app.get('/api/admin/pending-withdraws-role', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'withdraw_approver'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const { data, error } = await supabase
        .from('withdraw_requests')
        .select(`
            id, user_id, amount, currency, account_info, status, created_at,
            users (first_name, username),
            withdraw_methods (name, card, confirm)
        `)
        .eq('status', 'pending')
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    const formatted = (data || []).map(w => ({
        id: w.id, user_id: w.user_id, user_name: w.users?.first_name || 'Desconocido',
        username: w.users?.username, amount: w.amount, currency: w.currency,
        account_info: w.account_info, method_name: w.withdraw_methods?.name,
        method_card: w.withdraw_methods?.card, method_confirm: w.withdraw_methods?.confirm,
        created_at: w.created_at
    }));
    res.json(formatted);
});

// Aprobar retiro (withdraw_approver o admin)
app.post('/api/admin/pending-withdraws-role/:id/approve', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'withdraw_approver'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const { id } = req.params;
    const { data: request, error: fetchError } = await supabase
        .from('withdraw_requests').update({ status: 'approved', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id).eq('status', 'pending').select().single();
    if (fetchError || !request) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });

    const user = await getOrCreateUser(request.user_id);
    const debitPlan = await buildRealBalanceDebitPlan(user, parseFloat(request.amount), request.currency);
    if (!debitPlan.ok) return res.status(400).json({ error: debitPlan.errorMessage || 'Saldo insuficiente' });

    let newCup = (parseFloat(user.cup) || 0) - debitPlan.cupDebit;
    let newUsd = (parseFloat(user.usd) || 0) - debitPlan.usdDebit;
    await supabase.from('users').update({ cup: newCup, usd: newUsd, updated_at: new Date() }).eq('telegram_id', request.user_id);

    try {
        if (bot && bot.telegram) await bot.telegram.sendMessage(request.user_id,
            `✅ <b>Retiro aprobado</b>\n\n💰 Monto retirado: ${request.amount} ${request.currency}\n💵 Se debitaron ${debitPlan.cupDebit.toFixed(2)} CUP y ${debitPlan.usdDebit.toFixed(2)} USD de tu saldo real.\n\n📌 En breve los fondos serán enviados a tu cuenta.`,
            { parse_mode: 'HTML' });
    } catch (e) {}
    updatePendingNotifications(`withdraw_${id}`, `✅ <b>Retiro #${id} aprobado</b> por un administrador.`);
    res.json({ success: true });
});

// Rechazar retiro (withdraw_approver o admin)
app.post('/api/admin/pending-withdraws-role/:id/reject', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'withdraw_approver'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const { id } = req.params;
    const { data: request, error: fetchError } = await supabase
        .from('withdraw_requests').update({ status: 'rejected', processed_at: new Date(), processed_by: parseInt(userId) })
        .eq('id', id).eq('status', 'pending').select().single();
    if (fetchError || !request) return res.status(404).json({ error: 'Solicitud no encontrada o ya procesada' });
    try {
        if (bot && bot.telegram) await bot.telegram.sendMessage(request.user_id,
            `❌ <b>Retiro rechazado</b>\n\n💰 Monto: ${parseFloat(request.amount)} ${String(request.currency || '').toUpperCase()}\n📌 Tu solicitud no pudo ser procesada. Si crees que esto es incorrecto, por favor contáctanos para más información.`,
            { parse_mode: 'HTML' });
    } catch (e) {}
    updatePendingNotifications(`withdraw_${id}`, `❌ <b>Retiro #${id} rechazado</b> por un administrador.`);
    res.json({ success: true });
});

// Obtener configuración de horarios (schedule_manager o admin)
app.get('/api/admin/schedule-config', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'schedule_manager'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const start = await getWithdrawTimeStart();
    const end = await getWithdrawTimeEnd();
    const { data: overrideData } = await supabase
        .from('app_config')
        .select('value')
        .eq('key', 'withdraw_manual_override')
        .single();
    const manualOverride = overrideData?.value || 'none';
    const available = await isWithdrawTime();
    res.json({ start, end, manualOverride, available });
});

// Actualizar horario de retiros (schedule_manager o admin)
app.put('/api/admin/schedule-config', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'schedule_manager'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }
    const { start, end } = req.body;

    try {
        const wasOpen = await isWithdrawTime();

        if (start !== undefined) {
            await supabase.from('app_config').upsert({ key: 'withdraw_time_start', value: start.toString() }, { onConflict: 'key' });
        }
        if (end !== undefined) {
            await supabase.from('app_config').upsert({ key: 'withdraw_time_end', value: end.toString() }, { onConflict: 'key' });
        }

        if (start !== undefined || end !== undefined) {
            const { data: overrideData } = await supabase
                .from('app_config')
                .select('value')
                .eq('key', 'withdraw_manual_override')
                .single();
            const currentOverride = overrideData?.value || 'none';

            if (currentOverride === 'open') {
                await supabase
                    .from('app_config')
                    .upsert({ key: 'withdraw_schedule_changed', value: 'true' }, { onConflict: 'key' });
            } else if (wasOpen) {
                await supabase
                    .from('app_config')
                    .upsert({ key: 'withdraw_manual_override', value: 'none' }, { onConflict: 'key' });
                await supabase
                    .from('app_config')
                    .upsert({ key: 'withdraw_manual_override_expiry', value: null }, { onConflict: 'key' });

                const now = moment.tz(TIMEZONE);
                const currentHour = now.hour() + now.minute() / 60;
                const newStart = start !== undefined ? start : await getWithdrawTimeStart();
                const newEnd = end !== undefined ? end : await getWithdrawTimeEnd();

                if (currentHour < newStart || currentHour >= newEnd) {
                    const startStr = formatHour12(newStart);
                    const endStr = formatHour12(newEnd);
                    const todayStart = now.clone().startOf('day').add(newStart, 'hours');
                    const nextOpeningIsToday = now.isBefore(todayStart);
                    const openingDayStr = nextOpeningIsToday ? 'hoy' : 'mañana';
                    await broadcastToAllUsers(
                        `⏰ <b>Horario de Retiros CERRADO</b>\n\n` +
                        `La ventana de retiros ha finalizado. Vuelve ${openingDayStr} en su nuevo horario de ${startStr} a ${endStr} (hora Cuba).`
                    );
                    await supabase
                        .from('app_config')
                        .upsert({ key: 'withdraw_schedule_changed', value: 'false' }, { onConflict: 'key' });
                } else {
                    await supabase
                        .from('app_config')
                        .upsert({ key: 'withdraw_schedule_changed', value: 'true' }, { onConflict: 'key' });
                }
            } else {
                await supabase
                    .from('app_config')
                    .upsert({ key: 'withdraw_schedule_changed', value: 'true' }, { onConflict: 'key' });
            }
        }

        res.json({ success: true, message: 'Horario actualizado' });
    } catch (e) {
        res.status(500).json({ error: 'Error al actualizar horario' });
    }
});

// Toggle manual de retiros (schedule_manager o admin)
app.post('/api/admin/schedule-toggle', async (req, res) => {
    const userId = req.verifiedTelegramId;
    if (!userId) return res.status(403).json({ error: 'No autorizado' });
    if (!isAdmin(userId) && !(await hasRole(userId, 'schedule_manager'))) {
        return res.status(403).json({ error: 'No tienes permisos' });
    }

    const { action } = req.body;
    if (!action || !['open', 'close'].includes(action)) {
        return res.status(400).json({ error: 'Acción inválida. Use "open" o "close".' });
    }

    // Reutilizar la lógica del endpoint existente
    const wasOpen = await isWithdrawTime();
    const start = await getWithdrawTimeStart();
    const end = await getWithdrawTimeEnd();

    await supabase
        .from('app_config')
        .upsert({ key: 'withdraw_manual_override', value: action }, { onConflict: 'key' });

    const nowOpen = await isWithdrawTime();

    if (wasOpen === nowOpen) {
        return res.status(400).json({
            error: wasOpen
                ? 'La sesión ya está abierta por el horario programado. No se puede cerrar manualmente.'
                : 'La sesión ya está cerrada fuera del horario programado.'
        });
    }

    // Apply expiry logic matching admin endpoint
    const now = moment.tz(TIMEZONE);
    let expiryDate = null;

    if (action === 'open') {
        const currentHour = now.hour() + now.minute() / 60;
        const insideWindow = currentHour >= start && currentHour < end;
        if (insideWindow) {
            expiryDate = now.clone().startOf('day').add(end, 'hours').toDate();
        } else {
            await clearManualOverrideExpiry();
        }
    } else {
        const todayStart = now.clone().startOf('day').add(start, 'hours');
        if (now.isBefore(todayStart)) {
            expiryDate = todayStart.toDate();
        } else {
            expiryDate = todayStart.add(1, 'day').toDate();
        }
    }

    if (expiryDate) {
        await setManualOverrideExpiry(expiryDate);
    } else {
        await clearManualOverrideExpiry();
    }

    // Notificar a todos los usuarios (mismo mensaje que admin endpoint)
    const startStr = formatHour12(start);
    const endStrFormatted = formatHour12(end);
    let message = '';
    if (action === 'open') {
        message =
            `⏰ <b>Horario de Retiros ABIERTO</b>\n\n` +
            `Ya puedes solicitar tus retiros desde este momento.\n` +
            `Puedes retirar en CUP, USD, USDT, TRX o MLC según los métodos disponibles.`;
    } else {
        const todayStart = now.clone().startOf('day').add(start, 'hours');
        const nextOpeningIsToday = now.isBefore(todayStart);
        const openingDayStr = nextOpeningIsToday ? 'hoy' : 'mañana';
        message =
            `⏰ <b>Horario de Retiros CERRADO</b>\n\n` +
            `La ventana de retiros ha finalizado. Se reabrirá ${openingDayStr} de ${startStr} a ${endStrFormatted} (hora Cuba).`;
    }

    await broadcastToAllUsers(message, 'HTML');

    res.json({ success: true, available: nowOpen });
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

// ========== MANEJADORES GLOBALES DE ERRORES ==========
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason?.message || reason);
    if (reason?.stack) console.error(reason.stack);
});
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err?.message || err);
    if (err?.stack) console.error(err.stack);
});

// ========== INICIAR SERVIDOR Y BOT ==========
app.listen(PORT, () => {
    console.log(`🚀 Backend corriendo en http://localhost:${PORT}`);
    console.log(`📡 WebApp servida en ${WEBAPP_URL}`);
    console.log(`🤖 Iniciando bot de Telegram...`);
});

// Import and launch bot asynchronously to support ESM modules with top-level await
// Load bot via require (CommonJS) and launch it. Use promise handlers
// instead of top-level await/import to avoid ambiguous module format errors
try {
    const required = require('./bot.js');
    bot = required.default || required;

    // Compartir el tracker de notificaciones con bot.js
    bot.pendingNotifications = pendingNotifications;

    // Actualizar botInfo inmediatamente (sin esperar al launch)
    if (bot && bot.telegram && typeof bot.telegram.getMe === 'function') {
        bot.telegram.getMe().then(info => {
            botInfo = info;
            console.log('Bot info actualizada:', botInfo);
        }).catch(e => console.error('Error actualizando botInfo:', e));
    }

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
                            bot.telegram.getMe().then(info => {
                                botInfo = info;
                                console.log('Bot info actualizada:', botInfo);
                            }).catch(e => console.error('Error actualizando botInfo:', e));
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
