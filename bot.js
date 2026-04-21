// ==============================
// bot.js - Bot de Telegram para 4pu3$t4$_Qva
// Versión completa con todas las funcionalidades:
// - Registro de usuarios con bono en CUP (solo una vez) - AHORA PRIMERO BIENVENIDA, LUEGO BONO
// - Apuestas en CUP/USD (fijo, corridos, centena, parle)
// - Depósitos y retiros multi-moneda (CUP, USD, USDT, TRX, MLC)
// - Transferencias entre usuarios (solo CUP/USD)
// - Panel de administración completo
// - Notificaciones de sesiones y números ganadores
// - Horarios de retiros (10:00 PM - 11:30 PM hora Cuba)
// - Emojis regionales en números ganadores
// - Corrección de NaN en bono
// - Retiros cripto con campos separados (wallet + red)
// - SISTEMA DE SOPORTE: los mensajes de usuarios se reenvían a admins con opción de responder
// ==============================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const LocalSession = require('telegraf-session-local');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');
const moment = require('moment-timezone');
const axios = require('axios');

// ========== CONFIGURACIÓN DESDE .ENV ==========
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = process.env.ADMIN_IDS ? process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim())) : [];
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BONUS_CUP_DEFAULT = parseFloat(process.env.BONUS_CUP_DEFAULT) || 70;
const TIMEZONE = process.env.TIMEZONE || 'America/Havana';
const WEBAPP_URL = process.env.WEBAPP_URL || 'http://localhost:3000';

// ========== HORARIO DE RETIROS (hora Cuba) ==========
// Disponibles diariamente de 10:00 PM a 11:30 PM (hora Cuba)
const WITHDRAW_HOURS = { start: 22, end: 23.5};

function isWithdrawTime() {  
    const now = moment.tz(TIMEZONE);
    const currentHour = now.hour() + now.minute() / 60;
    return currentHour >= WITHDRAW_HOURS.start && currentHour < WITHDRAW_HOURS.end;
}

// ========== INICIALIZAR SUPABASE ==========
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ========== INICIALIZAR BOT ==========
const bot = new Telegraf(BOT_TOKEN);

// ========== CONFIGURAR COMANDOS DEL MENÚ LATERAL ==========
const MENU_COMMANDS = [
  { command: 'start', description: '🏠 Inicio' },
  { command: 'jugar', description: '🎲 Jugar' },
  { command: 'mi_dinero', description: '💰 Mi dinero' },
  { command: 'mis_jugadas', description: '📋 Mis jugadas' },
  { command: 'referidos', description: '👥 Referidos' },
    { command: 'webapp', description: '🌐 Abrir Web-App' },
  { command: 'ayuda', description: '❓ Ayuda' },
    { command: 'cancel', description: '❌ Cancelar operación' }
];

async function setMenuCommandsWithRetry(attempt = 1) {
    try {
        await bot.telegram.setMyCommands(MENU_COMMANDS);
        console.log('✅ Comandos del bot configurados');
    } catch (err) {
        const isTimeout = err?.code === 'ETIMEDOUT' || err?.errno === 'ETIMEDOUT';
        const retryDelay = Math.min(5000 * Math.pow(2, attempt - 1), 60000);
        console.error(`Error al setear comandos (intento ${attempt}):`, err?.message || err);

        if (isTimeout || attempt < 5) {
            setTimeout(() => {
                setMenuCommandsWithRetry(attempt + 1);
            }, retryDelay);
        }
    }
}

setMenuCommandsWithRetry();

// ========== SESIÓN LOCAL ==========
const localSession = new LocalSession({ database: 'session_db.json' });
bot.use(localSession.middleware());

// ========== FUNCIÓN PARA VERIFICAR SI UN USUARIO ES ADMIN ==========
function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

async function userHasApprovedDeposit(telegramId) {
    try {
        const { count, error } = await supabase
            .from('deposit_requests')
            .select('*', { count: 'exact', head: true })
            .eq('user_id', parseInt(telegramId))
            .eq('status', 'approved');

        if (error) {
            console.error('Error verificando depósitos aprobados (bot):', error);
            return false;
        }

        return (count || 0) > 0;
    } catch (e) {
        console.error('Excepción verificando depósitos aprobados (bot):', e);
        return false;
    }
}

// ========== FUNCIONES AUXILIARES =====dame el comando para la migracion en sql console=====

function escapeHTML(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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

function buildLastBetsText(bets) {
    let text = '📋 <b>Tus últimas 5 jugadas:</b>\n\n';

    bets.forEach((b, i) => {
        const date = moment(b.placed_at).tz(TIMEZONE).format('DD/MM/YYYY hh:mm A');
        const lottery = escapeHTML(b.lottery || '-');
        const betType = escapeHTML(formatBetTypeLabel(b.bet_type) || '-');
        const rawTextLines = String(b.raw_text || '')
            .split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => escapeHTML(line.replace(/\s+/g, ' ')));
        const rawText = rawTextLines.length ? rawTextLines.join('\n') : '-';
        const cup = (parseFloat(b.cost_cup) || 0).toFixed(2);
        const usd = (parseFloat(b.cost_usd) || 0).toFixed(2);

        text += `<b>${i + 1}.</b>\n` +
            `<pre>Lotería : ${lottery}\nTipo    : ${betType}\nJugada  : ${rawText}\nMonto   : ${cup} CUP / ${usd} USD\nFecha y Hora : ${date}</pre>\n`;
    });

    text += '¿Quieres ver más? Puedes consultar el historial completo en la Web-App.';
    return text;
}

function buildDepositApprovedMessage({ depositedAmountText, creditedAmount, creditedCurrency, includeUsdFollowup = false, bonusMovedCup = 0, showBonusMovedNotice = false }) {
    let text =
        `✅ <b>Depósito aprobado</b>\n\n` +
        `💰 Monto depositado: ${depositedAmountText}\n` +
        `💵 Se acreditaron ${creditedAmount.toFixed(2)} ${creditedCurrency} a tu saldo ${creditedCurrency}.\n`;

    if (includeUsdFollowup) {
        text += `ℹ️Con tu saldo USD también puedes transferir en CUP; además retirar en CUP, USDT, TRX o MLC según los métodos disponibles.\n`;
    }

    if (bonusMovedCup > 0) {
        text += `🎁 Tu bono de bienvenida de ${bonusMovedCup.toFixed(2)} CUP se ha movido a tu saldo principal.\n`;
    } else if (showBonusMovedNotice) {
        text += `🎁 Tu bono de bienvenida se ha movido a tu saldo principal.\n`;
    }

    text += `\n\n¡Gracias por confiar en nosotros!`;
    return text;
}

async function safeEdit(ctx, text, keyboard = null) {
    try {
        if (ctx.callbackQuery) {
            await ctx.editMessageText(text, {
                parse_mode: 'HTML',
                reply_markup: keyboard?.reply_markup
            });
        } else {
            await ctx.reply(text, {
                parse_mode: 'HTML',
                reply_markup: keyboard?.reply_markup
            });
        }
    } catch (err) {
        console.warn('Error en safeEdit, enviando nuevo mensaje:', err.message);
        try {
            await ctx.reply(text, {
                parse_mode: 'HTML',
                reply_markup: keyboard?.reply_markup
            });
        } catch (e) {}
    }
}

function clearPendingFlow(session) {
    const pendingKeys = [
        'supportReplyTo',
        'awaitingBet', 'betType', 'lottery', 'sessionId',
        'awaitingDepositPhoto', 'awaitingDepositAmount', 'depositMethod', 'depositPhotoBuffer',
        'awaitingWithdrawAmount', 'withdrawMethod', 'withdrawAmount', 'withdrawCurrency',
        'awaitingWithdrawWallet', 'withdrawWallet',
        'awaitingWithdrawNetwork', 'withdrawNetwork',
        'awaitingWithdrawAccount',
        'awaitingTransferTarget', 'transferTarget', 'awaitingTransferAmount',
        'adminAction', 'adminStep',
        'adminTempName', 'adminTempCurrency', 'adminTempCard',
        'editMethodId', 'editMethodType', 'editStep', 'editField',
        'priceStep', 'priceTempMultiplier', 'priceTempMinCup',
        'minStep', 'minTempCup', 'minTempUsd', 'maxTempCup',
        'winningSessionId',
        'withdrawRequest',
        'withdrawFlowAllowed'
        ,'withdrawTemplateKey'
    ];

    let cleared = false;
    for (const key of pendingKeys) {
        if (Object.prototype.hasOwnProperty.call(session, key)) {
            delete session[key];
            cleared = true;
        }
    }
    return cleared;
}

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

// ========== RETIRO: PLANTILLAS POR MONEDA ==========
const withdrawalTemplates = {
    CUP: {
        messages: [
            "Retiro CUP\nMínimo: {min} CUP\n\n\nPor favor, ingresa tu tarjeta CUP",
            "Retiro CUP\n\n\nIndica tu móvil a confirmar",
            "Retiro CUP\nMínimo: {min} CUP\n🇨🇺 CUP real disponible: {balance}\n\n\nEscribe el monto que deseas retirar en CUP (ej: 600 para 600 CUP)."
        ]
    },
    USDT: {
        messages: [
            "Retirar USDT\nMínimo: {min} {currency}\n\n\nPor favor, ingresa tu wallet USDT",
            "Retirar USDT\n\n\nIndica tu red\nAhora, por favor, escribe la red que usarás (ej: TRC-20, BEP-20, etc. Asegúrate de usar la red correcta para evitar pérdidas)",
            "Retirar USDT\nMínimo: {min} {currency}\n🪙 USDT real disponible: {balance}\n\n\nEscribe el monto que deseas retirar en {currency} (ej: 10 para 10 {currency})."
        ]
    },
    USD: {
        messages: [
            "Retiro USD\nMínimo: {min} USD\n\n\nPor favor, ingresa tu tarjeta USD",
            "Retiro USD\n\n\nIndica tu móvil a confirmar",
            "Retiro USD\nMínimo: {min} USD\n💵 USD real disponible: {balance}\n\n\nEscribe el monto que deseas retirar en USD (ej: 10 para 10 USD)."
        ]
    },
    TRX: {
        messages: [
            "Retirar TRX\nMínimo: {min} {currency}\n\n\nPor favor, ingresa tu wallet TRX",
            "Retirar TRX\n\n\nIndica tu red\nAhora, por favor, escribe la red que usarás (ej: TRC-20. Asegúrate de usar la red correcta para evitar pérdidas)",
            "Retirar TRX\nMínimo: {min} {currency}\n🪙 TRX real disponible: {balance}\n\n\nEscribe el monto que deseas retirar en {currency} (ej: 100 para 100 {currency})."
        ]
    },
    MLC: {
        messages: [
            "Retiro MLC\nMínimo: {min} MLC\n\n\nPor favor, ingresa tu tarjeta MLC",
            "Retiro MLC\n\n\nIndica tu móvil a confirmar",
            "Retiro MLC\nMínimo: {min} MLC\n🏦 MLC real disponible: {balance}\n\n\nEscribe el monto que deseas retirar en MLC (ej: 10 para 10 MLC)."
        ]
    }
    // Puedes agregar más monedas siguiendo el mismo patrón
};

// Construye plantillas por defecto con el mismo formato que las plantillas definidas
function buildFallbackWithdrawalTemplates(method, balance, min, currencyLabel) {
    const cur = (currencyLabel || method?.currency || '').toString().trim();
    const label = cur || 'CUP';

    // Para cripto pedir wallet primero; para no-cripto pedir tarjeta/dato primero
    const isCrypto = ['USDT', 'TRX'].includes(canonicalizeCurrency(cur));

    if (isCrypto) {
        return [
            `Retirar ${label}\nMínimo: ${min} ${label}\n\n\nPor favor, ingresa tu wallet ${label}`,
            `Retirar ${label}\n\n\nIndica tu red\nAhora, por favor, escribe la red que usarás (ej: TRC-20, BEP-20, etc.).`,
            `Retirar ${label}\nMínimo: ${min} ${label}\n🪙 ${label} real disponible: ${balance}\n\n\nEscribe el monto que deseas retirar en ${label} (ej: 10 para 10 ${label}).`
        ];
    }

    // No-cripto (CUP, USD, MLC)
    return [
        `Retiro ${label}\nMínimo: ${min} ${label}\n\n\nPor favor, ingresa tu tarjeta ${label}`,
        `Retiro ${label}\n\n\nIndica tu móvil a confirmar`,
        `Retiro ${label}\nMínimo: ${min} ${label}\n${label === 'CUP' ? '🇨🇺 ' : ''}${label} real disponible: ${balance}\n\n\nEscribe el monto que deseas retirar en ${label} (ej: 600 para 600 ${label}).`
    ];
}

function getWithdrawalTemplate(currency, balance, min, currencyLabel) {
    // Normalize the incoming currency value to a canonical token (e.g. 'usd','USD','USD-TRC20' -> 'USD')
    const key = canonicalizeCurrency(String(currency || ''));
    // Only use exact key matches from the user's templates. Avoid fallback to other templates.
    const tpl = withdrawalTemplates[key];

    if (!tpl || !Array.isArray(tpl.messages)) return null;
    const label = currencyLabel || key;
    return tpl.messages.map(m => (m || '')
        .replace(/{balance}/g, typeof balance !== 'undefined' ? String(balance) : '0.00')
        .replace(/{min}/g, typeof min !== 'undefined' ? String(min) : String(tpl.minimum || '0'))
        .replace(/{currency}/g, label)
    );
}

function canonicalizeCurrency(currency) {
    if (!currency) return '';
    // Toma el primer token alfanumérico y retorna en mayúsculas (quita emojis/puntuación)
    const raw = String(currency).trim();
    const match = raw.match(/[A-Za-z0-9]+/);
    return match ? match[0].toUpperCase() : raw.toUpperCase();
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
        const availableInCurrency = await convertFromCUP(totalAvailableCUP, currency);
        return {
            ok: false,
            amountCUP,
            totalAvailableCUP,
            cupBalance,
            usdBalance,
            rateUSD,
            cupDebit: 0,
            usdDebit: 0,
            errorMessage: `Saldo insuficiente en ${currency}. Disponible: ${availableInCurrency.toFixed(2)} ${currency}`
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
                errorMessage: `Saldo insuficiente en USD. Disponible: ${usdBalance.toFixed(2)} USD`
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

// ========== FUNCIÓN GETUSER MODIFICADA (AHORA NO ENVÍA BONO DIRECTAMENTE) ==========
async function getUser(telegramId, firstName = 'Jugador', username = null, ctx = null) {
    try {
        const { data: user, error } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', telegramId)
            .maybeSingle();

        if (error) {
            console.error('Error al consultar usuario:', error);
            return { cup: 0, usd: 0, first_name: firstName, username, telegram_id: telegramId };
        }

        if (user) {
            if (username && user.username !== username) {
                await supabase.from('users').update({ username }).eq('telegram_id', telegramId);
            }
            // Migrar bono a saldo principal solo si el usuario ya tuvo depósito aprobado
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
                console.error('Error migrando bono por saldo existente (bot):', e);
            }
            return user;
        }

        const { data: newUser, error: insertError } = await supabase
            .from('users')
            .insert({
                telegram_id: telegramId,
                first_name: firstName,
                username: username,
                cup: 0,
                usd: 0,
                bonus_cup: BONUS_CUP_DEFAULT
            })
            .select()
            .single();

        if (insertError) {
            console.error('Error al crear usuario:', insertError);
            const { data: retryUser } = await supabase
                .from('users')
                .select('*')
                .eq('telegram_id', telegramId)
                .maybeSingle();
            if (retryUser) return retryUser;
            return { cup: 0, usd: 0, bonus_cup: BONUS_CUP_DEFAULT, first_name: firstName, username, telegram_id: telegramId };
        }

        if (ctx?.session) {
            ctx.session.isNewUser = true;
        }

        return newUser;
    } catch (e) {
        console.error('Error inesperado en getUser:', e);
        return { cup: 0, usd: 0, bonus_cup: 0, first_name: firstName, username, telegram_id: telegramId };
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

function parseBetLine(line, betType) {
    line = line.trim().toLowerCase();
    if (!line) return [];

    const match = line.match(/^([\d\s,xtd]+)\s*(?:con|\*)\s*([0-9.]+)\s*(usd|cup|usdt|trx|mlc)$/i);
    if (!match) return [];

    let numerosStr = match[1].trim();
    const montoStr = match[2];
    const moneda = match[3].toLowerCase();

    const numeros = numerosStr.split(/[\s,]+/).filter(n => n.length > 0);
    const montoBase = parseFloat(montoStr);
    if (isNaN(montoBase) || montoBase <= 0) return [];

    const resultados = [];

    for (let numero of numeros) {
        const expanded = expandDTNumbers(numero, betType);
        if (expanded.length > 0) {
            for (const expandedNumber of expanded) {
                resultados.push({
                    numero: expandedNumber,
                    usd: moneda === 'usd' ? montoBase : 0,
                    cup: moneda === 'cup' ? montoBase : 0
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
            usd: moneda === 'usd' ? montoBase : 0,
            cup: moneda === 'cup' ? montoBase : 0
        });
    }

    return resultados;
}

function parseBetMessage(text, betType) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    const items = [];
    let totalUSD = 0, totalCUP = 0;

    for (const line of lines) {
        const parsedItems = parseBetLine(line, betType);
        for (const item of parsedItems) {
            items.push(item);
            totalUSD += item.usd;
            totalCUP += item.cup;
        }
    }

    return {
        items,
        totalUSD,
        totalCUP,
        ok: items.length > 0
    };
}

const regionMap = {
    'Florida': { key: 'florida', emoji: '🦩' },
    'Georgia': { key: 'georgia', emoji: '🍑' },
    'Nueva York': { key: 'newyork', emoji: '🗽' }
};

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
    if (now.isSameOrAfter(endTime)) return null;
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

async function createDepositRequest(userId, methodId, fileBuffer, amountText, currency) {
    const fileName = `deposit_${userId}_${Date.now()}.jpg`;
    const filePath = `deposits/${fileName}`;

    const { error: uploadError } = await supabase.storage
        .from('deposit-screenshots')
        .upload(filePath, fileBuffer, { contentType: 'image/jpeg' });

    if (uploadError) throw new Error('Error al subir captura');

    const { data: { publicUrl } } = supabase.storage
        .from('deposit-screenshots')
        .getPublicUrl(filePath);

    const { data: request, error: insertError } = await supabase
        .from('deposit_requests')
        .insert({
            user_id: userId,
            method_id: methodId,
            screenshot_url: publicUrl,
            amount: amountText,
            currency: currency,
            status: 'pending'
        })
        .select()
        .single();

    if (insertError) throw insertError;

    return request;
}

function getMainKeyboard(ctx) {
    const buttons = [
        ['🎲 Jugar', '💰 Mi dinero'],
        ['📋 Mis jugadas', '👥 Referidos'],
        ['❓ Cómo jugar', '🌐 Abrir Web-App'],
        ['❌ Cancelar']
    ];
    if (isAdmin(ctx.from.id)) {
        buttons.push(['🔧 Admin']);
    }
    return Markup.keyboard(buttons).resize();
}

function playLotteryKbd() {
    const buttons = [
        [Markup.button.callback('🦩 Florida', 'lot_florida')],
        [Markup.button.callback('🍑 Georgia', 'lot_georgia')],
        [Markup.button.callback('🗽 Nueva York', 'lot_newyork')],
        [Markup.button.callback('◀ Volver', 'main')]
    ];
    return Markup.inlineKeyboard(buttons);
}

function playTypeKbd() {
    const buttons = [
        [Markup.button.callback('🎯 Fijo', 'type_fijo'), Markup.button.callback('🏃 Corridos', 'type_corridos')],
        [Markup.button.callback('💯 Centena', 'type_centena'), Markup.button.callback('🔒 Parle', 'type_parle')],
        [Markup.button.callback('◀ Volver', 'play')]
    ];
    return Markup.inlineKeyboard(buttons);
}

function myMoneyKbd() {
    const buttons = [
        [Markup.button.callback('📥 Recargar', 'recharge')],
        [Markup.button.callback('📤 Retirar', 'withdraw')],
        [Markup.button.callback('🔄 Transferir', 'transfer')],
        [Markup.button.callback('◀ Volver', 'main')]
    ];
    return Markup.inlineKeyboard(buttons);
}

function adminPanelKbd() {
    const buttons = [
        [
            Markup.button.callback('🎰 Gestionar sesiones', 'admin_sessions'),
            Markup.button.callback('🔢 Publicar ganadores', 'admin_winning')
        ],
        [
            Markup.button.callback('➕ Añadir método DEPÓSITO', 'adm_add_dep'),
            Markup.button.callback('➕ Añadir método RETIRO', 'adm_add_wit')
        ],
        [
            Markup.button.callback('🗑 Eliminar método DEPÓSITO', 'adm_delete_dep'),
            Markup.button.callback('🗑 Eliminar método RETIRO', 'adm_delete_wit')
        ],
        [
            Markup.button.callback('💰 Configurar tasa MLC/CUP', 'adm_set_rate_mlc'),
            Markup.button.callback('💰 Configurar tasa USD/CUP', 'adm_set_rate_usd')
        ],
        [
            Markup.button.callback('💰 Configurar tasa USDT/CUP', 'adm_set_rate_usdt'),
            Markup.button.callback('💰 Configurar tasa TRX/CUP', 'adm_set_rate_trx')
        ],
        [
            Markup.button.callback('🎲 Configurar precios y pagos', 'adm_set_prices'),
            Markup.button.callback('💰 Mínimos por jugada', 'adm_min_per_bet')
        ],
        [Markup.button.callback('📋 Ver datos actuales', 'adm_view')],
        [Markup.button.callback('◀ Menú principal', 'main')]
    ];
    return Markup.inlineKeyboard(buttons);
}

function getAllowedHours(lotteryKey) {
    const schedules = {
        florida: {
            name: 'Florida',
            emoji: '🦩',
            slots: [
                { name: '🌅 Mañana', start: 9, end: 13 },
                { name: '🌙 Noche',  start: 14, end: 21 }
            ]
        },
        georgia: {
            name: 'Georgia',
            emoji: '🍑',
            slots: [
                { name: '🌅 Mañana', start: 9, end: 12 },
                { name: '☀️ Tarde',  start: 14, end: 18.5 },
                { name: '🌙 Noche',  start: 20, end: 23 }
            ]
        },
        newyork: {
            name: 'Nueva York',
            emoji: '🗽',
            slots: [
                { name: '🌅 Mañana', start: 9, end: 14 },
                { name: '🌙 Noche',  start: 15, end: 22 }
            ]
        }
    };
    return schedules[lotteryKey];
}

// ========== MIDDLEWARE MEJORADO (AHORA PASA EL CONTEXTO A GETUSER) ==========
bot.use(async (ctx, next) => {
    const uid = ctx.from?.id;
    if (uid) {
        try {
            const firstName = ctx.from.first_name || 'Jugador';
            const username = ctx.from.username || null;
            // Pasamos ctx para que pueda marcar nuevo usuario en sesión
            const user = await getUser(uid, firstName, username, ctx);
            ctx.dbUser = user || { cup: 0, usd: 0 };
        } catch (e) {
            console.error('Error cargando usuario en middleware:', e);
            ctx.dbUser = { cup: 0, usd: 0 };
        }
    }
    return next();
});

// ========== COMANDOS ==========
bot.command('start', async (ctx) => {
    const uid = ctx.from.id;
    const firstName = ctx.from.first_name || 'Jugador';
    const refParam = ctx.payload;

    if (refParam) {
        const refId = parseInt(refParam);
        if (refId && refId !== uid) {
            await supabase
                .from('users')
                .update({ ref_by: refId })
                .eq('telegram_id', uid);
        }
    }

    // Mensaje de bienvenida (ahora primero)
    await safeEdit(ctx,
        `👋 ¡Hola, ${escapeHTML(firstName)}! Bienvenido a 4pu3$t4$_Qva, tu asistente de la suerte 🍀\n\n` +
        `Estamos encantados de tenerte aquí. ¿Listo para jugar y ganar? 🎲\n\n` +
        `Usa los botones del menú para explorar todas las opciones. Si tienes dudas, solo escríbenos.`,
        getMainKeyboard(ctx)
    );

    if (ctx.session?.isNewUser) {
        const bonusAmount = parseFloat(ctx.dbUser?.bonus_cup);
        const normalizedBonus = Number.isFinite(bonusAmount) ? bonusAmount : BONUS_CUP_DEFAULT;
        const bonusDisplay = Number.isInteger(normalizedBonus) ? normalizedBonus.toFixed(0) : normalizedBonus.toFixed(2);
        await ctx.reply(
            `🎁 <b>¡Bono de bienvenida!</b>\n\n` +
            `Has recibido <b>${bonusDisplay} CUP</b> como bono no retirable.\n` +
            `Puedes usar este bono para jugar y ganar premios reales. ¡Buena suerte! 🍀`,
            { parse_mode: 'HTML' }
        );
        ctx.session.isNewUser = false;
    }
});

bot.command('jugar', async (ctx) => {
    await safeEdit(ctx, '🎲 Por favor, selecciona una lotería para comenzar a jugar:', playLotteryKbd());
});

bot.command('mi_dinero', async (ctx) => {
    const user = ctx.dbUser;
    const rate = await getExchangeRateUSD();
    const cup = parseFloat(user.cup) || 0;
    const usd = parseFloat(user.usd) || 0;
    const bonusCup = parseFloat(user.bonus_cup) || 0;
    const cupToUsd = (cup / rate).toFixed(2);
    const usdToCup = (usd * rate).toFixed(2);

    const text = `💰 <b>Tu saldo actual es:</b>\n\n` +
        `🇨🇺 <b>CUP:</b> ${cup.toFixed(2)} (principal)\n` +
        `💵 <b>USD:</b> ${usd.toFixed(2)} (aprox. ${usdToCup} CUP)\n` +
        `🎁 <b>Bono (no retirable):</b> ${bonusCup.toFixed(2)} CUP\n\n` +
        `¿Qué deseas hacer?`;
    await safeEdit(ctx, text, myMoneyKbd());
});

bot.command('mis_jugadas', async (ctx) => {
    const uid = ctx.from.id;
    const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('user_id', uid)
        .order('placed_at', { ascending: false })
        .limit(5);

    if (!bets || bets.length === 0) {
        await safeEdit(ctx,
            '📭 Aún no has realizado ninguna jugada. ¡Anímate a participar! 🎲\n\n' +
            'Para jugar, selecciona "🎲 Jugar" en el menú y sigue las instrucciones.',
            getMainKeyboard(ctx)
        );
    } else {
        const text = buildLastBetsText(bets);
        await safeEdit(ctx, text, getMainKeyboard(ctx));
    }
});

bot.command('referidos', async (ctx) => {
    const uid = ctx.from.id;
    const { count } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('ref_by', uid);

    const botInfo = await ctx.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${uid}`;

    await safeEdit(ctx,
        `💸 <b>¡GANA DINERO EXTRA INVITANDO AMIGOS! 💰</b>\n\n` +
        `🎯 <b>¿Cómo funciona?</b>\n` +
        `1️⃣ Comparte tu enlace personal con amigos\n` +
        `2️⃣ Cuando se registren y jueguen, tú ganas una comisión\n` +
        `3️⃣ Recibirás un porcentaje de CADA apuesta que realicen\n` +
        `4️⃣ ¡Es automático y para siempre! 🔄\n\n` +
        `🔥 Sin límites, sin topes, sin esfuerzo.\n\n` +
        `📲 <b>Tu enlace mágico:</b> 👇\n` +
        `<code>${escapeHTML(link)}</code>\n\n` +
        `📊 <b>Tus estadísticas:</b>\n` +
        `👥 Referidos registrados: ${count || 0}\n\n` +
        `¡Comparte y empieza a ganar hoy mismo!`,
        getMainKeyboard(ctx)
    );
});

bot.command('ayuda', async (ctx) => {
    await safeEdit(ctx,
        '📩 <b>¿Tienes dudas o necesitas ayuda?</b>\n\n' +
        'Puedes escribir directamente en este chat. Tu mensaje será recibido por nuestro equipo de soporte y te responderemos a la mayor brevedad.\n\n',
        Markup.inlineKeyboard([[Markup.button.callback('◀ Volver al inicio', 'main')]])
    );
});

bot.command('webapp', async (ctx) => {
    const webAppButton = Markup.inlineKeyboard([
        Markup.button.webApp('🚀 Abrir Web-App', `${WEBAPP_URL}/app.html`)
    ]);
    await ctx.reply('Haz clic en el botón para acceder a nuestra plataforma web interactiva:', webAppButton);
});

bot.command('cancel', async (ctx) => {
    const cleared = clearPendingFlow(ctx.session || {});
    if (cleared) {
        await ctx.reply('✅ Operación cancelada. Ya puedes realizar otra acción.', getMainKeyboard(ctx));
    } else {
        await ctx.reply('ℹ️ No hay ninguna operación en curso para cancelar.', getMainKeyboard(ctx));
    }
});

// ========== ACCIONES ==========
bot.action('main', async (ctx) => {
    const firstName = ctx.from.first_name || 'Jugador';
    await safeEdit(ctx,
        `👋 ¡Hola de nuevo, ${escapeHTML(firstName)}! ¿En qué podemos ayudarte hoy?\n\n` +
        `Selecciona una opción del menú para continuar.`,
        getMainKeyboard(ctx)
    );
});

bot.action('play', async (ctx) => {
    await safeEdit(ctx, '🎲 Elige una lotería para comenzar:', playLotteryKbd());
});

bot.action(/lot_(.+)/, async (ctx) => {
    try {
        const lotteryKey = ctx.match[1];
        const lotteryName = lotteryKey === 'florida' ? 'Florida' : lotteryKey === 'georgia' ? 'Georgia' : 'Nueva York';
        const region = regionMap[lotteryName];
        const schedule = getAllowedHours(lotteryKey);

        const now = moment.tz(TIMEZONE);
        const currentMinutes = now.hours() * 60 + now.minutes();
        const isAllowed = schedule.slots.some(slot => {
            const startMinutes = slot.start * 60;
            const endMinutes = slot.end * 60;
            return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
        });

        if (!isAllowed) {
            let hoursText = '';
            for (const slot of schedule.slots) {
                const startStr = moment().tz(TIMEZONE).hours(Math.floor(slot.start)).minutes((slot.start % 1) * 60).format('h:mm A');
                const endStr = moment().tz(TIMEZONE).hours(Math.floor(slot.end)).minutes((slot.end % 1) * 60).format('h:mm A');
                hoursText += `${slot.name}: ${startStr} - ${endStr}\n`;
            }

            const errorMsg = 
                `⏰ <b>Horario no disponible para ${schedule.emoji} ${schedule.name}</b>\n\n` +
                `📅 Los horarios permitidos (hora de Cuba) son:\n${hoursText}\n` +
                `🔄 Por favor, intenta dentro del horario o elige otra lotería. ¡Te esperamos!`;

            await safeEdit(ctx, errorMsg, playLotteryKbd());
            return;
        }

        const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
        const { data: activeSession, error } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('lottery', lotteryName)
            .eq('date', today)
            .eq('status', 'open')
            .maybeSingle();

        if (error) {
            console.error('Error al consultar sesión:', error);
            await ctx.reply('❌ Lo sentimos, ocurrió un error al verificar la sesión. Por favor, intenta más tarde.', getMainKeyboard(ctx));
            return;
        }

        if (!activeSession) {
            let hoursText = '';
            for (const slot of schedule.slots) {
                const startStr = moment().tz(TIMEZONE).hours(Math.floor(slot.start)).minutes((slot.start % 1) * 60).format('h:mm A');
                const endStr = moment().tz(TIMEZONE).hours(Math.floor(slot.end)).minutes((slot.end % 1) * 60).format('h:mm A');
                hoursText += `${slot.name}: ${startStr} - ${endStr}\n`;
            }
            const errorMsg = 
                `❌ <b>No hay una sesión abierta en este momento para ${schedule.emoji} ${schedule.name}</b>\n\n` +
                `📅 Horarios de juego (hora de Cuba):\n${hoursText}\n` +
                `🔄 Por favor, espera a que se abra una sesión o elige otra lotería. ¡Estamos contigo!`;
            await safeEdit(ctx, errorMsg, playLotteryKbd());
            return;
        }

        ctx.session.lottery = lotteryName;
        ctx.session.sessionId = activeSession.id;
        await safeEdit(ctx,
            `✅ Has seleccionado <b>${escapeHTML(lotteryName)}</b> - Turno <b>${escapeHTML(activeSession.time_slot)}</b>.\n` +
            `Ahora elige el tipo de jugada que deseas realizar:`,
            playTypeKbd()
        );
    } catch (e) {
        console.error('Error en lot_ handler:', e);
        await ctx.reply('❌ Ups, ocurrió un error inesperado. Por favor, intenta de nuevo.', getMainKeyboard(ctx));
    }
});

bot.action(/type_(.+)/, async (ctx) => {
    const betType = ctx.match[1];
    ctx.session.betType = betType;
    ctx.session.awaitingBet = true;
    const lottery = ctx.session.lottery || 'Florida';

    const { data: price } = await supabase
        .from('play_prices')
        .select('payout_multiplier, min_cup, min_usd, max_cup, max_usd')
        .eq('bet_type', betType)
        .single();

    let priceInfo = '';
    if (price) {
        priceInfo = `🎁 <b>Pago de Jugada:</b> x${price.payout_multiplier}\n` +
                    `📉 <b>Mín:</b> ${price.min_cup} CUP / ${price.min_usd} USD  ` +
                    `📈 <b>Máx:</b> ${price.max_cup || '∞'} CUP / ${price.max_usd || '∞'} USD\n\n`;
    }

    let instructions = '';
    switch (betType) {
        case 'fijo':
            instructions = `🎯 <b>FIJO</b> - ${regionMap[lottery]?.emoji || '🎰'} ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada jugada. Puedes poner varios números de 2 DÍGITOS separados por espacios o comas en la misma línea.\n` +
                `<b>Formato:</b> <code>12 con 5 cup</code> o <code>79 10 34*20 cup</code>\n` +
                `También puedes usar <b>D</b> (decena) o <b>T</b> (terminal):\n` +
                `- <code>D2 con 5 cup</code> significa 20, 21, ..., 29 con 5 cup cada uno.\n` +
                `- <code>T5 con 5 cup</code> significa 05, 15, ..., 95 con 5 cup cada uno.\n\n` +
                `Ejemplos:\n12 con 5 cup\n34*2 usd\n79 10 34 con 50 cup\nD2 con 5 cup\nT5*1 usd\n\n` +
                `💭 <b>Escribe tus jugadas (una o varias líneas):</b>`;
            break;
        case 'corridos':
            instructions = `🏃 <b>CORRIDOS</b> - ${regionMap[lottery]?.emoji || '🎰'} ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada número de 2 DÍGITOS, o varios separados.\n` +
                `<b>Formato:</b> <code>17 con 5 cup</code> o <code>32 33*10 cup</code>\n\n` +
                `Ejemplos:\n17 con 5 cup\n32 33*10 cup\n62 con 1 usd\n\nD5 con 1 usd\nT9*20 cup\n\n` +
                `💭 <b>Escribe tus jugadas:</b>`;
            break;
        case 'centena':
            instructions = `💯 <b>CENTENA</b> - ${regionMap[lottery]?.emoji || '🎰'} ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada número de 3 DÍGITOS, o varios separados.\n` +
                `<b>Formato:</b> <code>517 con 8 cup</code> o <code>419 123*10 cup</code>\n\n` +
                `Ejemplos:\n517 con 8 cup\n419 123*10 cup\n234 con 0.5 usd\n\n` +
                `💭 <b>Escribe tus jugadas:</b>`;
            break;
        case 'parle':
            instructions = `🔒 <b>PARLE</b> - ${regionMap[lottery]?.emoji || '🎰'} ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada combinación de dos números de 2 DÍGITOS, separados por "x"; o varias combinaciones separadas.\n` +
                `<b>Formato:</b> <code>17x32 con 5 cup</code> o <code>21x93 54x95*2 cup</code>\n\n` +
                `Ejemplos:\n17x32 con 5 cup\n21x93 54x95 con 2 cup\n32x62*0.5 usd\n\n` +
                `💭 <b>Escribe tus parles:</b>`;
            break;
    }
    await safeEdit(ctx, instructions, null);
});

bot.action('my_money', async (ctx) => {
    const user = ctx.dbUser;
    const rate = await getExchangeRateUSD();
    const cup = parseFloat(user.cup) || 0;
    const usd = parseFloat(user.usd) || 0;
    const bonusCup = parseFloat(user.bonus_cup) || 0;
    const cupToUsd = (cup / rate).toFixed(2);
    const usdToCup = (usd * rate).toFixed(2);

    const text = `💰 <b>Tu saldo actual es:</b>\n\n` +
        `🇨🇺 <b>CUP:</b> ${cup.toFixed(2)} (principal)\n` +
        `💵 <b>USD:</b> ${usd.toFixed(2)} (aprox. ${usdToCup} CUP)\n` +
        `🎁 <b>Bono (no retirable):</b> ${bonusCup.toFixed(2)} CUP\n\n` +
        `¿Qué deseas hacer?`;
    await safeEdit(ctx, text, myMoneyKbd());
});

bot.action('recharge', async (ctx) => {
    const { data: methods } = await supabase
        .from('deposit_methods')
        .select('*')
        .order('id', { ascending: true });

    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('❌ Por el momento no hay métodos de depósito disponibles. Intenta más tarde.', { show_alert: true });
        return;
    }

    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `dep_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Volver', 'my_money')]);

    await safeEdit(ctx,
        `💵 Recargar saldo\n\nPor favor, elige un método de pago\n\nSelecciona el método:`,
        Markup.inlineKeyboard(buttons)
    );
    try { await ctx.answerCbQuery(); } catch (e) {}
});

bot.action(/^dep_(\d+)$/, async (ctx) => {
    const methodId = parseInt(ctx.match[1]);
    const { data: method } = await supabase
        .from('deposit_methods')
        .select('*')
        .eq('id', methodId)
        .single();

    if (!method) {
        await ctx.answerCbQuery('Método no encontrado. Por favor, selecciona otro.', { show_alert: true });
        return;
    }

    try { await ctx.answerCbQuery(); } catch (e) {}

    ctx.session.depositMethod = method;
    ctx.session.awaitingDepositAmount = true;

    let extraInstructions = '';
    if (method.currency === 'USDT' || method.currency === 'TRX') {
        extraInstructions = `\n\n🔐 <b>Importante:</b>\n- Envía el monto exacto en ${escapeHTML(method.currency)} a la dirección indicada.\n- Asegúrate de usar la red correcta: ${escapeHTML(method.confirm && method.confirm.includes('TRC20') ? 'TRC-20' : method.confirm && method.confirm.includes('BEP20') ? 'BEP-20' : method.confirm || 'la red especificada')}.\n- La captura debe mostrar claramente el hash de la transacción (TXID) y el monto.`;
    }

    const minLine = (method.min_amount !== null && method.min_amount !== undefined) ? `Mínimo: ${escapeHTML(String(method.min_amount))} ${escapeHTML(method.currency)}\n\n` : '';

    await safeEdit(ctx,
        `🧾 <b>${escapeHTML(method.name)}</b>\n` +
        `Moneda: ${escapeHTML(method.currency)}\n` +
        `Datos: <code>${escapeHTML(method.card)}</code>\n` +
        `Confirmar / Red: <code>${escapeHTML(method.confirm)}</code>\n` +
        `${minLine}` +
        `${extraInstructions}\n\n` +
        `📥 <b>Por favor, envía el monto transferido</b> con la moneda (ej: <code>500 cup</code> o <code>10 usd</code>, etc).`,
        null
    );
});

bot.action('withdraw', async (ctx) => {
    if (!isWithdrawTime()) {
        const startStr = moment.tz(TIMEZONE).hours(22).minutes(0).format('h:mm A');
        const endStr = moment.tz(TIMEZONE).hours(23).minutes(30).format('h:mm A');
        await ctx.answerCbQuery(
            `⏰ Los retiros solo están disponibles de ${startStr} a ${endStr} (hora de Cuba). Por favor, intenta en ese horario.`,
            { show_alert: true }
        );
        return;
    }

    // Marcar que el usuario inició el flujo de retiro dentro del horario.
    // Esto permitirá que complete el flujo aunque el horario expire mientras interactúa.
    if (ctx.session) ctx.session.withdrawFlowAllowed = true;

    const { data: methods } = await supabase
        .from('withdraw_methods')
        .select('*')
        .order('id', { ascending: true });

    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('❌ Por el momento no hay métodos de retiro disponibles. Intenta más tarde.', { show_alert: true });
        return;
    }

    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `wit_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Volver', 'my_money')]);

    await safeEdit(ctx, '📤 <b>Selecciona un método de retiro:</b>', Markup.inlineKeyboard(buttons));
});

bot.action(/^wit_(\d+)$/, async (ctx) => {
    const methodId = parseInt(ctx.match[1]);
    const { data: method } = await supabase
        .from('withdraw_methods')
        .select('*')
        .eq('id', methodId)
        .single();

    if (!method) {
        await ctx.answerCbQuery('Método no encontrado. Por favor, selecciona otro.', { show_alert: true });
        return;
    }

    ctx.session.withdrawMethod = method;
    // Guardar la clave de plantilla exacta al pulsar el botón (ej: 'CUP', 'USD', 'USDT')
    ctx.session.withdrawTemplateKey = canonicalizeCurrency(method.currency);
    // Inicializar el flujo de retiro según la moneda:
    // - Para cripto: pedir wallet primero
    // - Para CUP/USD/MLC: pedir datos de cuenta (tarjeta/telefono) en pasos separados
    if (method.currency === 'USDT' || method.currency === 'TRX') {
        ctx.session.awaitingWithdrawWallet = true;
    } else {
        // Primer paso para métodos no-cripto: pedir tarjeta / datos iniciales
        ctx.session.awaitingWithdrawAccountCard = true;
    }

    const user = ctx.dbUser;
    // Obtener mínimo desde el método de retiro en la BD (sin mínimos globales)
    const methodMin = method.min_amount !== null && method.min_amount !== undefined ? parseFloat(method.min_amount) : 0;

    let saldoEnMoneda = 0;
    let mensajeSaldo = '';
    let balanceForTemplate = '0.00';
    // Calcular saldo real: sumar CUP + USD convertido a CUP, luego convertir al currency de la plantilla
    const cupBalance0 = parseFloat(user.cup) || 0;
    const usdBalance0 = parseFloat(user.usd) || 0;
    const rateUSD0 = await getExchangeRateUSD();
    const totalAvailableCUP0 = cupBalance0 + (usdBalance0 * rateUSD0);

    if (method.currency === 'USD') {
        // Para retiros en USD usar únicamente el saldo USD
        balanceForTemplate = usdBalance0.toFixed(2);
        mensajeSaldo = `💵 USD real disponible: ${usdBalance0.toFixed(2)}`;
    } else {
        const balanceConverted0 = await convertFromCUP(totalAvailableCUP0, method.currency);
        balanceForTemplate = balanceConverted0.toFixed(2);
        if (method.currency === 'CUP') {
            mensajeSaldo = `🇨🇺 CUP real disponible: ${totalAvailableCUP0.toFixed(2)}`;
        } else {
            mensajeSaldo = `💰 Equivalente disponible: ${balanceConverted0.toFixed(2)} ${method.currency}`;
        }
    }

    let instruccionesAdicionales = '';
    if (method.currency === 'USDT' || method.currency === 'TRX') {
        instruccionesAdicionales = `\n\n🔐 <b>Para retiros en ${method.currency}:</b>\n` +
            `- Después de confirmar el monto, te pediré por separado:\n` +
            `   • Dirección de wallet\n` +
            `   • Red (ej: TRC-20 para USDT, sugerida: ${method.confirm !== 'ninguno' ? method.confirm : 'la que corresponda'})\n` +
            `- Asegúrate de usar la red correcta para evitar pérdidas.`;
    }

    // Intentar obtener plantilla específica para la moneda usando la clave guardada
    const currencyCode = ctx.session.withdrawTemplateKey || canonicalizeCurrency(method.currency);
    const templates = getWithdrawalTemplate(currencyCode, balanceForTemplate, methodMin, method.currency);
    if (templates && templates.length >= 1) {
        // Enviar solo el primer mensaje de la plantilla y continuar el flujo paso a paso
        await safeEdit(ctx,
            `Has elegido <b>${escapeHTML(method.name)}</b> (moneda: ${method.currency}).\n` + templates[0],
            null
        );
    } else {
        // No usar fallback: cancelar flujo y notificar al usuario
        delete ctx.session.awaitingWithdrawWallet;
        delete ctx.session.awaitingWithdrawAccountCard;
        delete ctx.session.withdrawMethod;
        delete ctx.session.withdrawTemplateKey;
        await ctx.reply(`⚠️ El método seleccionado (${escapeHTML(method.name)} - ${escapeHTML(method.currency)}) no tiene plantilla válida para continuar. Por favor, contacta al administrador.`, getMainKeyboard(ctx));
        return;
    }
});

bot.action('transfer', async (ctx) => {
    // Paso 1: elegir moneda
    ctx.session.awaitingTransferCurrency = true;
    const currencyButtons = [
        [Markup.button.callback('🇨🇺 CUP', 'transfer_currency_CUP'), Markup.button.callback('💵 USD', 'transfer_currency_USD')],
        [Markup.button.callback('◀ Cancelar', 'main')]
    ];
    await safeEdit(ctx, '🔄 <b>Transferir saldo a otro usuario</b>\n\nSelecciona la moneda que deseas transferir:', Markup.inlineKeyboard(currencyButtons));
});

// Acción para elegir moneda de transferencia
bot.action(/^transfer_currency_(CUP|USD)$/, async (ctx) => {
    const currency = ctx.match[1];
    ctx.session.transferCurrency = currency;
    // Buscar el método de depósito más reciente para la moneda seleccionada
    const { data: allMethods } = await supabase
        .from('deposit_methods')
        .select('*')
        .order('id', { ascending: true });
    const methods = (allMethods || []).filter(m => {
        const curr = (m.currency || '').toString().trim().toUpperCase();
        return curr === currency;
    });
    if (!methods || methods.length === 0) {
        await ctx.reply(`❌ No hay métodos de depósito activos para transferir ${currency}.`, getMainKeyboard(ctx));
        return;
    }
    // Elegir el método más reciente (mayor id)
    const method = methods.reduce((a, b) => (a.id > b.id ? a : b));
    ctx.session.transferDepositMethod = method;
    ctx.session.awaitingTransferTarget = true;
    delete ctx.session.awaitingTransferCurrency;
    // Mensaje original de pedir usuario (no modificar)
    let minLine = (method.min_amount !== null && method.min_amount !== undefined) ? `\nMínimo: ${method.min_amount} ${method.currency}` : '';
    await safeEdit(ctx,
        '🔄 <b>Transferir saldo a otro usuario</b>\n\n' +
        'Envía el <b>nombre de usuario</b> de Telegram (ej: @usuario) de la persona a la que deseas transferir.\n' +
        'También puedes usar su ID numérico si lo conoces.' +
        minLine +
        '\n\nEl bono de bienvenida no es transferible.\n\nPor favor, ingresa el usuario:',
        null
    );
});

bot.action('my_bets', async (ctx) => {
    const uid = ctx.from.id;
    const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('user_id', uid)
        .order('placed_at', { ascending: false })
        .limit(5);

    if (!bets || bets.length === 0) {
        await safeEdit(ctx,
            '📭 No tienes jugadas registradas. ¡Anímate a participar! 🎲\n\n' +
            'Selecciona "🎲 Jugar" en el menú para empezar.',
            getMainKeyboard(ctx)
        );
    } else {
        const text = buildLastBetsText(bets);
        await safeEdit(ctx, text, getMainKeyboard(ctx));
    }
});

bot.action('referrals', async (ctx) => {
    const uid = ctx.from.id;
    const { count } = await supabase
        .from('users')
        .select('*', { count: 'exact', head: true })
        .eq('ref_by', uid);

    const botInfo = await ctx.telegram.getMe();
    const link = `https://t.me/${botInfo.username}?start=${uid}`;

    await safeEdit(ctx,
        `💸 <b>¡GANA DINERO EXTRA INVITANDO AMIGOS! 💰</b>\n\n` +
        `🎯 <b>¿Cómo funciona?</b>\n` +
        `1️⃣ Comparte tu enlace personal con amigos\n` +
        `2️⃣ Cuando se registren y jueguen, tú ganas una comisión\n` +
        `3️⃣ Recibirás un porcentaje de CADA apuesta que realicen\n` +
        `4️⃣ ¡Es automático y para siempre! 🔄\n\n` +
        `🔥 Sin límites, sin topes, sin esfuerzo.\n\n` +
        `📲 <b>Tu enlace mágico:</b> 👇\n` +
        `<code>${escapeHTML(link)}</code>\n\n` +
        `📊 <b>Tus estadísticas:</b>\n` +
        `👥 Referidos registrados: ${count || 0}\n\n` +
        `¡Comparte y empieza a ganar hoy mismo!`,
        getMainKeyboard(ctx)
    );
});

bot.action('how_to_play', async (ctx) => {
    await safeEdit(ctx,
        '📩 <b>¿Necesitas ayuda?</b>\n\n' +
        'Puedes escribirnos directamente en este chat. Nuestro equipo de soporte te responderá a la mayor brevedad.\n\n',
        Markup.inlineKeyboard([[Markup.button.callback('◀ Volver al inicio', 'main')]])
    );
});

bot.action('admin_panel', async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ No autorizado. Solo administradores.', { show_alert: true });
        return;
    }
    await safeEdit(ctx, '🔧 <b>Panel de administración</b>\nSelecciona una opción:', adminPanelKbd());
});

bot.action('admin_sessions', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    await showRegionsMenu(ctx);
});

async function showRegionsMenu(ctx) {
    const buttons = [
        [Markup.button.callback('🦩 Florida', 'sess_region_Florida')],
        [Markup.button.callback('🍑 Georgia', 'sess_region_Georgia')],
        [Markup.button.callback('🗽 Nueva York', 'sess_region_Nueva York')],
        [Markup.button.callback('◀ Volver a Admin', 'admin_panel')]
    ];
    await safeEdit(ctx, '🎰 <b>Gestionar sesiones de juego</b>\n\nSelecciona una región:', Markup.inlineKeyboard(buttons));
}

bot.action(/sess_region_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const lottery = ctx.match[1];
    await showRegionSessions(ctx, lottery);
});

async function showRegionSessions(ctx, lottery) {
    try {
        const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');
        const { data: sessions } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('lottery', lottery)
            .eq('date', today);

        const region = regionMap[lottery];
        if (!region) {
            await ctx.answerCbQuery('❌ Región no válida', { show_alert: true });
            return;
        }
        const schedule = getAllowedHours(region.key);

        let text = `🎰 <b>${region.emoji} ${lottery}</b>\n📅 ${today}\n\n`;
        const buttons = [];

        for (const slot of schedule.slots) {
            const turno = slot.name;
            const session = sessions.find(s => s.time_slot === turno);
            let estado, btnText, callbackData;
            if (session) {
                estado = session.status === 'open' ? '✅ Activa' : '🔴 Cerrada';
                btnText = `${turno} (${estado}) - ${session.status === 'open' ? 'Cerrar' : 'Abrir'}`;
                callbackData = `toggle_session_${session.id}_${session.status}`;
            } else {
                estado = '⚪ Inactiva';
                btnText = `${turno} (${estado}) - Abrir`;
                callbackData = `create_session_${lottery}_${turno}`;
            }
            buttons.push([Markup.button.callback(btnText, callbackData)]);
            text += `• ${turno}: ${estado}\n`;
        }

        buttons.push([Markup.button.callback('◀ Cambiar región', 'admin_sessions')]);
        buttons.push([Markup.button.callback('◀ Volver a Admin', 'admin_panel')]);

        await safeEdit(ctx, text, Markup.inlineKeyboard(buttons));
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al cargar sesiones. Intenta más tarde.', { show_alert: true });
    }
};

bot.action(/create_session_(.+)_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const lottery = ctx.match[1];
        const timeSlot = ctx.match[2];
        const endTime = getEndTimeFromSlot(lottery, timeSlot);
        if (!endTime) {
            await ctx.answerCbQuery(`❌ La hora de cierre para el turno ${timeSlot} ya pasó hoy. No se puede abrir.`, { show_alert: true });
            return;
        }
        const today = moment.tz(TIMEZONE).format('YYYY-MM-DD');

        const { data: existing } = await supabase
            .from('lottery_sessions')
            .select('id')
            .eq('lottery', lottery)
            .eq('date', today)
            .eq('time_slot', timeSlot)
            .maybeSingle();

        if (existing) {
            await ctx.answerCbQuery('❌ Ya existe una sesión para este turno hoy.', { show_alert: true });
            return;
        }

        const { error } = await supabase
            .from('lottery_sessions')
            .insert({
                lottery,
                date: today,
                time_slot: timeSlot,
                status: 'open',
                end_time: endTime.toISOString()
            });

        if (error) throw error;

        await ctx.answerCbQuery('✅ Sesión abierta correctamente');

        const region = regionMap[lottery];
        await broadcastToAllUsers(
            `🎲 <b>¡SESIÓN ABIERTA!</b> 🎲\n\n` +
            `✨ La región ${region?.emoji || '🎰'} <b>${escapeHTML(lottery)}</b> acaba de abrir su turno de <b>${escapeHTML(timeSlot)}</b>.\n` +
            `💎 ¡Es tu momento! Realiza tus apuestas y llévate grandes premios.\n\n` +
            `⏰ Cierre: ${moment(endTime).tz(TIMEZONE).format('HH:mm')} (hora Cuba)\n` +
            `🍀 ¡La suerte te espera!`
        );

        await showRegionSessions(ctx, lottery);
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al abrir sesión. Revisa los logs.', { show_alert: true });
    }
});

bot.action(/toggle_session_(\d+)_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const sessionId = parseInt(ctx.match[1]);
        const currentStatus = ctx.match[2];
        const newStatus = currentStatus === 'open' ? 'closed' : 'open';

        const { error } = await supabase
            .from('lottery_sessions')
            .update({ status: newStatus, updated_at: new Date() })
            .eq('id', sessionId);

        if (error) throw error;

        const { data: session } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('id', sessionId)
            .single();

        const region = regionMap[session.lottery];
        if (newStatus === 'closed') {
            await broadcastToAllUsers(
                `🔴 <b>SESIÓN CERRADA</b>\n\n` +
                `🎰 ${region?.emoji || '🎰'} <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
                `📅 Fecha: ${session.date}\n\n` +
                `❌ Ya no se reciben más apuestas para esta sesión.\n` +
                `🔢 Pronto anunciaremos el número ganador. ¡Mantente atento!`
            );
        }

        await ctx.answerCbQuery(newStatus === 'open' ? '✅ Sesión abierta' : '🔴 Sesión cerrada');
        await showRegionSessions(ctx, session.lottery);
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al cambiar estado. Intenta más tarde.', { show_alert: true });
    }
});

// ========== ADMIN: AÑADIR MÉTODOS ==========
bot.action('adm_add_dep', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminAction = 'add_dep';
    ctx.session.adminStep = 1;
    await ctx.reply('➕ <b>Añadir nuevo método de DEPÓSITO</b>\n\nPaso 1/4: Escribe el <b>nombre</b> del método (ej: "USDT-TRC20", "Transfermovil CUP"):', { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_add_wit', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    ctx.session.adminAction = 'add_wit';
    ctx.session.adminStep = 1;
    await ctx.reply('➕ <b>Añadir nuevo método de RETIRO</b>\n\nPaso 1/4: Escribe el <b>nombre</b> del método (ej: "Efectivo USD", "USDT-BEP20"):', { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_edit_dep', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: methods } = await supabase.from('deposit_methods').select('*').order('id');
    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('No hay métodos de depósito para editar.', { show_alert: true });
        return;
    }
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `edit_dep_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('✏️ <b>Editar método de DEPÓSITO</b>\nSelecciona el método que deseas modificar:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action('adm_edit_wit', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: methods } = await supabase.from('withdraw_methods').select('*').order('id');
    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('No hay métodos de retiro para editar.', { show_alert: true });
        return;
    }
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `edit_wit_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('✏️ <b>Editar método de RETIRO</b>\nSelecciona el método que deseas modificar:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action('adm_delete_dep', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: methods } = await supabase.from('deposit_methods').select('*').order('id');
    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('No hay métodos de depósito para eliminar.', { show_alert: true });
        return;
    }
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `delete_dep_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('🗑 <b>Eliminar método de DEPÓSITO</b>\nSelecciona el método que deseas eliminar:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action('adm_delete_wit', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: methods } = await supabase.from('withdraw_methods').select('*').order('id');
    if (!methods || methods.length === 0) {
        await ctx.answerCbQuery('No hay métodos de retiro para eliminar.', { show_alert: true });
        return;
    }
    const buttons = methods.map(m => [Markup.button.callback(`${m.name} (${m.currency})`, `delete_wit_${m.id}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('🗑 <b>Eliminar método de RETIRO</b>\nSelecciona el método que deseas eliminar:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action(/edit_dep_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const methodId = parseInt(ctx.match[1]);
    const { data: method } = await supabase.from('deposit_methods').select('*').eq('id', methodId).single();
    if (!method) {
        await ctx.answerCbQuery('Método no encontrado.', { show_alert: true });
        return;
    }
    ctx.session.editMethodId = methodId;
    ctx.session.editMethodType = 'deposit';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'choose_field';

    const buttons = [
        [Markup.button.callback('✏️ Nombre', 'edit_field_name')],
        [Markup.button.callback('✏️ Moneda', 'edit_field_currency')],
        [Markup.button.callback('✏️ Datos (card)', 'edit_field_card')],
        [Markup.button.callback('✏️ Confirmar / Red', 'edit_field_confirm')],
        [Markup.button.callback('✏️ Límite mínimo', 'edit_field_min_amount')],
        [Markup.button.callback('✏️ Límite máximo', 'edit_field_max_amount')],
        [Markup.button.callback('◀ Cancelar', 'admin_panel')]
    ];
    await ctx.reply(
        `✏️ Editando método <b>${escapeHTML(method.name)}</b> (ID: ${methodId})\n\n` +
        `Valores actuales:\n` +
        `📛 Nombre: ${escapeHTML(method.name)}\n` +
        `💱 Moneda: ${method.currency}\n` +
        `💳 Datos: ${escapeHTML(method.card)}\n` +
        `✅ Confirmar/Red: ${escapeHTML(method.confirm)}\n` +
        `📉 Mín: ${method.min_amount !== null ? method.min_amount : '-'}\n` +
        `📈 Máx: ${method.max_amount !== null ? method.max_amount : '-'}\n\n` +
        `¿Qué campo deseas modificar?`,
        Markup.inlineKeyboard(buttons)
    );
    await ctx.answerCbQuery();
});

bot.action(/edit_wit_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const methodId = parseInt(ctx.match[1]);
    const { data: method } = await supabase.from('withdraw_methods').select('*').eq('id', methodId).single();
    if (!method) {
        await ctx.answerCbQuery('Método no encontrado.', { show_alert: true });
        return;
    }
    ctx.session.editMethodId = methodId;
    ctx.session.editMethodType = 'withdraw';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'choose_field';

    const buttons = [
        [Markup.button.callback('✏️ Nombre', 'edit_field_name')],
        [Markup.button.callback('✏️ Moneda', 'edit_field_currency')],
        [Markup.button.callback('✏️ Datos (card)', 'edit_field_card')],
        [Markup.button.callback('✏️ Confirmar / Red', 'edit_field_confirm')],
        [Markup.button.callback('✏️ Límite mínimo', 'edit_field_min_amount')],
        [Markup.button.callback('✏️ Límite máximo', 'edit_field_max_amount')],
        [Markup.button.callback('◀ Cancelar', 'admin_panel')]
    ];
    await ctx.reply(
        `✏️ Editando método <b>${escapeHTML(method.name)}</b> (ID: ${methodId})\n\n` +
        `Valores actuales:\n` +
        `📛 Nombre: ${escapeHTML(method.name)}\n` +
        `💱 Moneda: ${method.currency}\n` +
        `💳 Datos: ${escapeHTML(method.card)}\n` +
        `✅ Confirmar/Red: ${escapeHTML(method.confirm)}\n` +
        `📉 Mín: ${method.min_amount !== null ? method.min_amount : '-'}\n` +
        `📈 Máx: ${method.max_amount !== null ? method.max_amount : '-'}\n\n` +
        `¿Qué campo deseas modificar?`,
        Markup.inlineKeyboard(buttons)
    );
    await ctx.answerCbQuery();
});

bot.action('edit_field_name', async (ctx) => {
    ctx.session.editField = 'name';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía el <b>nuevo nombre</b> del método:');
    await ctx.answerCbQuery();
});

bot.action('edit_field_currency', async (ctx) => {
    ctx.session.editField = 'currency';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía la <b>nueva moneda</b> (CUP, USD, USDT, TRX, MLC):');
    await ctx.answerCbQuery();
});

bot.action('edit_field_card', async (ctx) => {
    ctx.session.editField = 'card';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía el <b>nuevo dato</b> (número de cuenta, dirección wallet, etc.):');
    await ctx.answerCbQuery();
});

bot.action('edit_field_confirm', async (ctx) => {
    ctx.session.editField = 'confirm';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía el <b>nuevo dato de confirmación / red sugerida</b> (para cripto, la red; para otros, número a confirmar):');
    await ctx.answerCbQuery();
});

bot.action('edit_field_min_amount', async (ctx) => {
    ctx.session.editField = 'min_amount';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía el <b>nuevo límite mínimo</b> (0 = sin límite):');
    await ctx.answerCbQuery();
});

bot.action('edit_field_max_amount', async (ctx) => {
    ctx.session.editField = 'max_amount';
    ctx.session.adminAction = 'edit_method';
    ctx.session.editStep = 'awaiting_value';
    await ctx.reply('✏️ Envía el <b>nuevo límite máximo</b> (0 = sin límite):');
    await ctx.answerCbQuery();
});

bot.action(/confirm_delete_dep_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const methodId = parseInt(ctx.match[1]);
    const { error } = await supabase.from('deposit_methods').delete().eq('id', methodId);
    if (error) {
        await ctx.reply(`❌ Error al eliminar: ${error.message}`);
    } else {
        await ctx.reply('✅ Método de DEPÓSITO eliminado correctamente.');
    }
    await ctx.answerCbQuery();
    await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
});

bot.action(/confirm_delete_wit_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const methodId = parseInt(ctx.match[1]);
    const { error } = await supabase.from('withdraw_methods').delete().eq('id', methodId);
    if (error) {
        await ctx.reply(`❌ Error al eliminar: ${error.message}`);
    } else {
        await ctx.reply('✅ Método de RETIRO eliminado correctamente.');
    }
    await ctx.answerCbQuery();
    await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
});

bot.action('adm_set_rate_usd', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rate = await getExchangeRateUSD();
    ctx.session.adminAction = 'set_rate_usd';
    await ctx.reply(`💰 <b>Tasa USD/CUP actual:</b> 1 USD = ${rate} CUP\n\nEnvía la nueva tasa (solo número, ej: 120):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_set_rate_mlc', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rate = await getExchangeRateMLC();
    ctx.session.adminAction = 'set_rate_mlc';
    await ctx.reply(`💰 <b>Tasa MLC/CUP actual:</b> 1 MLC = ${rate} CUP\n\nEnvía la nueva tasa (solo número, ej: 120):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_set_rate_usdt', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rate = await getExchangeRateUSDT();
    ctx.session.adminAction = 'set_rate_usdt';
    await ctx.reply(`💰 <b>Tasa USDT/CUP actual:</b> 1 USDT = ${rate} CUP\n\nEnvía la nueva tasa (solo número, ej: 110):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_set_rate_trx', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rate = await getExchangeRateTRX();
    ctx.session.adminAction = 'set_rate_trx';
    await ctx.reply(`💰 <b>Tasa TRX/CUP actual:</b> 1 TRX = ${rate} CUP\n\nEnvía la nueva tasa (solo número, ej: 1.5):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_min_deposit', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const current = await getMinDepositUSD();
    ctx.session.adminAction = 'set_min_deposit';
    await ctx.reply(`💰 <b>Mínimo de depósito actual:</b> ${current} USD (equivale a ${(current * await getExchangeRateUSD()).toFixed(2)} CUP)\n\nEnvía el nuevo mínimo en USD (solo número, ej: 5):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_min_withdraw', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const current = await getMinWithdrawUSD();
    const rate = await getExchangeRateUSD();
    ctx.session.adminAction = 'set_min_withdraw';
    await ctx.reply(`💰 <b>Mínimo de retiro actual:</b> ${current} USD (equivale a ${(current * rate).toFixed(2)} CUP)\n\nEnvía el nuevo mínimo en USD (solo número, ej: 2):`, { parse_mode: 'HTML' });
    await ctx.answerCbQuery();
});

bot.action('adm_set_prices', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: prices } = await supabase.from('play_prices').select('*');
    const buttons = prices.map(p => [Markup.button.callback(p.bet_type, `set_price_${p.bet_type}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('🎲 <b>Configurar precios y pagos</b>\nElige el tipo de jugada que deseas modificar:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action(/set_price_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const betType = ctx.match[1];
    ctx.session.adminAction = 'set_price';
    ctx.session.betType = betType;
    ctx.session.priceStep = 1;
    await ctx.reply(
        `⚙️ Configurando precios para <b>${betType}</b>\n\n` +
        `Paso 1/3: Ingresa el multiplicador de premio (ej: 500):`,
        { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
});

bot.action('adm_min_per_bet', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const { data: prices } = await supabase.from('play_prices').select('*');
    const buttons = prices.map(p => [Markup.button.callback(p.bet_type, `set_min_${p.bet_type}`)]);
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);
    await ctx.reply('💰 <b>Configurar montos mínimos y máximos por jugada</b>\nElige el tipo de jugada:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action(/set_min_(.+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const betType = ctx.match[1];
    ctx.session.adminAction = 'set_min';
    ctx.session.betType = betType;
    ctx.session.minStep = 1;
    await ctx.reply(
        `⚙️ Configurando límites para <b>${betType}</b>\n\n` +
        `Paso 1/4: Ingresa el <b>monto mínimo en CUP</b> (0 = sin mínimo):`,
        { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
});

bot.action('adm_view', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rates = await getExchangeRates();
    const minDep = await getMinDepositUSD();
    const minWit = await getMinWithdrawUSD();
    const { data: depMethods } = await supabase.from('deposit_methods').select('*');
    const { data: witMethods } = await supabase.from('withdraw_methods').select('*');
    const { data: prices } = await supabase.from('play_prices').select('*');

    let text = `💰 <b>Tasas de cambio:</b>\n`;
    text += `MLC/CUP: 1 MLC = ${rates.rate_mlc} CUP\n`;
    text += `USD/CUP: 1 USD = ${rates.rate} CUP\n`;
    text += `USDT/CUP: 1 USDT = ${rates.rate_usdt} CUP\n`;
    text += `TRX/CUP: 1 TRX = ${rates.rate_trx} CUP\n\n`;
    text += `📥 <b>Mínimo depósito:</b> ${minDep} USD (${(minDep * rates.rate).toFixed(2)} CUP)\n`;
    text += `📤 <b>Mínimo retiro:</b> ${minWit} USD (${(minWit * rates.rate).toFixed(2)} CUP)\n\n`;
    text += `📥 <b>Métodos de DEPÓSITO:</b>\n`;
    depMethods?.forEach(m => text += `  ID ${m.id}: ${escapeHTML(m.name)} (${m.currency}) - ${escapeHTML(m.card)} / ${escapeHTML(m.confirm)} | Mín: ${m.min_amount !== null ? m.min_amount : '-'} | Máx: ${m.max_amount !== null ? m.max_amount : '-'}\n`);
    text += `\n📤 <b>Métodos de RETIRO:</b>\n`;
    witMethods?.forEach(m => text += `  ID ${m.id}: ${escapeHTML(m.name)} (${m.currency}) - ${escapeHTML(m.card)} / ${escapeHTML(m.confirm)} | Mín: ${m.min_amount !== null ? m.min_amount : '-'} | Máx: ${m.max_amount !== null ? m.max_amount : '-'}\n`);
    text += `\n🎲 <b>Precios por jugada (globales):</b>\n`;
    prices?.forEach(p => text += 
        `  ${p.bet_type}: Pago x${p.payout_multiplier || 0}  |  Mín: ${p.min_cup||0} CUP / ${p.min_usd||0} USD  |  Máx: ${p.max_cup||'∞'} CUP / ${p.max_usd||'∞'} USD\n`
    );

    await safeEdit(ctx, text, Markup.inlineKeyboard([[Markup.button.callback('◀ Volver a Admin', 'admin_panel')]]));
});

bot.action('admin_winning', async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;

    const { data: closedSessions } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('status', 'closed')
        .order('date', { ascending: false });

    const { data: published } = await supabase
        .from('winning_numbers')
        .select('lottery, date, time_slot');

    const publishedSet = new Set(published?.map(p => `${p.lottery}|${p.date}|${p.time_slot}`) || []);

    const availableSessions = closedSessions.filter(s =>
        !publishedSet.has(`${s.lottery}|${s.date}|${s.time_slot}`)
    );

    if (availableSessions.length === 0) {
        await ctx.reply('🔢 No hay sesiones cerradas pendientes de publicar. Todas las sesiones tienen números ganadores registrados.');
        return;
    }

    const buttons = availableSessions.map(s => {
        const region = regionMap[s.lottery];
        return [Markup.button.callback(
            `${region?.emoji || '🎰'} ${s.lottery} - ${s.date} (${s.time_slot})`,
            `publish_win_${s.id}`
        )];
    });
    buttons.push([Markup.button.callback('◀ Cancelar', 'admin_panel')]);

    await ctx.reply('🔢 <b>Publicar números ganadores</b>\nSelecciona la sesión para la cual deseas ingresar el número ganador:', Markup.inlineKeyboard(buttons));
    await ctx.answerCbQuery();
});

bot.action(/publish_win_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const sessionId = parseInt(ctx.match[1]);
    ctx.session.winningSessionId = sessionId;
    ctx.session.adminAction = 'winning_numbers';
    await ctx.reply(
        '✍️ <b>Ingresa el número ganador de 7 DÍGITOS</b>\n' +
        'Formato: centena (3) + cuarteta (4). Ejemplo: <code>5173262</code> o <code>517 3262</code>\n\n' +
        'Se desglosará automáticamente en:\n' +
        '• Centena: primeros 3 dígitos\n' +
        '• Fijo: últimos 2 de la centena\n' +
        '• Corridos: fijo, primeros 2 de cuarteta, últimos 2 de cuarteta\n' +
        '• Parles: combinaciones de los corridos',
        { parse_mode: 'HTML' }
    );
    await ctx.answerCbQuery();
});

function formatWinningNumber(num) {
    if (!num || num.length !== 7) return num;
    return num.slice(0, 3) + ' ' + num.slice(3);
}

async function processWinningNumber(sessionId, winningStr, ctx) {
    winningStr = winningStr.replace(/\s+/g, '');
    if (!/^\d{7}$/.test(winningStr)) {
        await ctx.reply('❌ El número debe tener EXACTAMENTE 7 dígitos. Por favor, inténtalo de nuevo.');
        return false;
    }

    const { data: session } = await supabase
        .from('lottery_sessions')
        .select('*')
        .eq('id', sessionId)
        .single();

    if (!session) {
        await ctx.reply('❌ Sesión no encontrada. Verifica el ID.');
        return false;
    }

    const { data: existingWin } = await supabase
        .from('winning_numbers')
        .select('id')
        .eq('lottery', session.lottery)
        .eq('date', session.date)
        .eq('time_slot', session.time_slot)
        .maybeSingle();

    if (existingWin) {
        await ctx.reply('❌ Esta sesión ya tiene un número ganador publicado. No se puede sobrescribir.');
        return false;
    }

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

    const { error: insertError } = await supabase
        .from('winning_numbers')
        .insert({
            lottery: session.lottery,
            date: session.date,
            time_slot: session.time_slot,
            numbers: [winningStr],
            published_at: new Date()
        });

    if (insertError) {
        await ctx.reply(`❌ Error al guardar: ${insertError.message}`);
        return false;
    }

    const { data: multipliers } = await supabase
        .from('play_prices')
        .select('bet_type, payout_multiplier');

    const multiplierMap = {};
    multipliers.forEach(m => { multiplierMap[m.bet_type] = parseFloat(m.payout_multiplier) || 0; });

    const { data: bets } = await supabase
        .from('bets')
        .select('*')
        .eq('session_id', sessionId);

    const formattedWinning = formatWinningNumber(winningStr);
    const BET_TYPE_ORDER = ['fijo', 'corridos', 'centena', 'parle'];

    const userResults = new Map();

    for (const bet of bets || []) {
        const { data: userBefore } = await supabase
            .from('users')
            .select('usd, cup, bonus_cup')
            .eq('telegram_id', bet.user_id)
            .single();

        if (!userResults.has(bet.user_id)) {
            const beforeUsd = parseFloat(userBefore?.usd) || 0;
            const beforeCup = parseFloat(userBefore?.cup) || 0;
            userResults.set(bet.user_id, {
                beforeUsd,
                beforeCup,
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
                    if (numero === centena) ganado = true;
                    break;
                case 'parle':
                    if (normalizedParles.has(normalizeParleValue(numero))) ganado = true;
                    break;
            }

            if (ganado) {
                premioTotalUSD += item.usd * multiplicador;
                premioTotalCUP += item.cup * multiplicador;
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

    const winnerIds = new Set();

    for (const [userId, result] of userResults.entries()) {
        let totalPremioUSD = 0;
        let totalPremioCUP = 0;

        for (const deptResult of result.departments.values()) {
            totalPremioUSD += deptResult.premioUSD;
            totalPremioCUP += deptResult.premioCUP;
        }

        if (totalPremioUSD > 0 || totalPremioCUP > 0) {
            winnerIds.add(String(userId));

            // Mover bono al saldo principal cuando el usuario gana
            let bonusMovedCup = 0;
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
                    bonusMovedCup = bonusVal;
                }

                const updatePayload = { usd: newUsd, cup: newCup, updated_at: new Date() };
                if (bonusMovedCup > 0) updatePayload.bonus_cup = 0;

                await supabase
                    .from('users')
                    .update(updatePayload)
                    .eq('telegram_id', userId);

                if (!globalThis.__bonusMovedByUser) globalThis.__bonusMovedByUser = new Map();
                globalThis.__bonusMovedByUser.set(String(userId), bonusMovedCup);
            } catch (e) {
                console.warn('Error moviendo bono al acreditar premio (bot):', e?.message || e);
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
            const typeLabel = escapeHTML(formatBetTypeLabel(betType));
            if (deptResult.won) {
                let text = `🎉 <b>¡FELICIDADES! Has ganado</b>\n\n` +
                    `🔢 Número ganador: <code>${formattedWinning}</code>\n` +
                    `🎰 ${regionMap[session.lottery]?.emoji || '🎰'} ${escapeHTML(session.lottery)} - ${escapeHTML(session.time_slot)}\n` +
                    `🏷️ Tipo: ${typeLabel}\n` +
                    `💰 Premio: ${deptResult.premioCUP.toFixed(2)} CUP / ${deptResult.premioUSD.toFixed(2)} USD\n` +
                    `✅ El premio ya fue acreditado a tu saldo. ¡Sigue disfrutando!`;

                const bonusMovedCup = (globalThis.__bonusMovedByUser && globalThis.__bonusMovedByUser.get(String(userId))) || 0;
                if (bonusMovedCup > 0) {
                    text += `\n\n🎁 Tu bono de bienvenida de ${bonusMovedCup.toFixed(2)} CUP se ha movido a tu saldo principal.`;
                }

                await bot.telegram.sendMessage(userId, text, { parse_mode: 'HTML' });
            } else {
                await bot.telegram.sendMessage(userId,
                    `🔢 <b>Números ganadores de ${regionMap[session.lottery]?.emoji || '🎰'} ${escapeHTML(session.lottery)} (${session.date} - ${escapeHTML(session.time_slot)})</b>\n\n` +
                    `Número: <code>${formattedWinning}</code>\n` +
                    `🏷️ Tipo: ${typeLabel}\n\n` +
                    `😔 No has ganado esta vez. ¡Sigue intentando!\n\n` +
                    `🍀 ¡Mucha suerte en la próxima!`,
                    { parse_mode: 'HTML' }
                );
            }
        }
    }

    const { data: allUsers } = await supabase
        .from('users')
        .select('telegram_id');

    const publicWinningMessage =
        `📢 <b>NÚMERO GANADOR PUBLICADO</b>\n\n` +
        `🎰 ${regionMap[session.lottery]?.emoji || '🎰'} <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
        `📅 Fecha: ${session.date}\n` +
        `🔢 Número: <code>${formattedWinning}</code>\n\n` +
        `💬 Revisa tu historial para ver si has ganado. ¡Mucha suerte en las próximas jugadas!`;

    for (const u of allUsers || []) {
        if (winnerIds.has(String(u.telegram_id))) continue;
        try {
            await bot.telegram.sendMessage(u.telegram_id, publicWinningMessage, { parse_mode: 'HTML' });
            await new Promise(resolve => setTimeout(resolve, 30));
        } catch (e) {
            console.warn(`Error enviando broadcast de ganador a ${u.telegram_id}:`, e.message);
        }
    }

    await ctx.reply(`✅ Números ganadores publicados y premios calculados correctamente.`);
    return true;
}

// ========== SISTEMA DE SOPORTE ==========
// Acción para que un admin responda a un usuario
bot.action(/support_reply_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ No autorizado', { show_alert: true });
        return;
    }
    const userId = parseInt(ctx.match[1]);
    ctx.session.supportReplyTo = userId;
    await ctx.reply(`✏️ Escribe ahora tu respuesta para el usuario. Se enviará cuando termines.`);
    await ctx.answerCbQuery();
});

// ========== MANEJADOR DE TEXTO PRINCIPAL ==========
bot.on(message('text'), async (ctx) => {
    const uid = ctx.from.id;
    const text = ctx.message.text.trim();
    const session = ctx.session;
    const user = ctx.dbUser;

    const normalizedText = text.toLowerCase();
    if (normalizedText === 'cancelar' || normalizedText === '/cancel' || normalizedText === '❌ cancelar') {
        const cleared = clearPendingFlow(session || {});
        if (cleared) {
            await ctx.reply('✅ Operación cancelada. Ya puedes realizar otra acción.', getMainKeyboard(ctx));
        } else {
            await ctx.reply('ℹ️ No hay ninguna operación en curso para cancelar.', getMainKeyboard(ctx));
        }
        return;
    }

    // 1. Verificar si es un admin respondiendo a un usuario
    if (isAdmin(uid) && session.supportReplyTo) {
        const targetUserId = session.supportReplyTo;
        try {
            await bot.telegram.sendMessage(targetUserId,
                `📨 <b>Respuesta de soporte:</b>\n\n${escapeHTML(text)}`,
                { parse_mode: 'HTML' }
            );
            await ctx.reply('✅ Respuesta enviada al usuario.');
        } catch (e) {
            await ctx.reply('❌ No se pudo enviar la respuesta. El usuario podría haber bloqueado el bot.');
        }
        delete session.supportReplyTo;
        return;
    }

    // 2. Verificar si es un botón del menú principal
    const mainButtons = ['🎲 Jugar', '💰 Mi dinero', '📋 Mis jugadas', '👥 Referidos', '❓ Cómo jugar', '🌐 Abrir Web-App', '🔧 Admin'];
    if (mainButtons.includes(text)) {
        if (text === '🎲 Jugar') {
            await safeEdit(ctx, '🎲 Por favor, selecciona una lotería para comenzar a jugar:', playLotteryKbd());
            return;
        } else if (text === '💰 Mi dinero') {
            const user = ctx.dbUser;
            const rate = await getExchangeRateUSD();
            const cup = parseFloat(user.cup) || 0;
            const usd = parseFloat(user.usd) || 0;
            const bonusCup = parseFloat(user.bonus_cup) || 0;
            const cupToUsd = (cup / rate).toFixed(2);
            const usdToCup = (usd * rate).toFixed(2);

            const text = `💰 <b>Tu saldo actual es:</b>\n\n` +
                `🇨🇺 <b>CUP:</b> ${cup.toFixed(2)} (principal)\n` +
                `💵 <b>USD:</b> ${usd.toFixed(2)} (aprox. ${usdToCup} CUP)\n` +
                `🎁 <b>Bono (no retirable):</b> ${bonusCup.toFixed(2)} CUP\n\n` +
                `¿Qué deseas hacer?`;
            await safeEdit(ctx, text, myMoneyKbd());
            return;
        } else if (text === '📋 Mis jugadas') {
            const uid = ctx.from.id;
            const { data: bets } = await supabase
                .from('bets')
                .select('*')
                .eq('user_id', uid)
                .order('placed_at', { ascending: false })
                .limit(5);

            if (!bets || bets.length === 0) {
                await safeEdit(ctx,
                    '📭 Aún no has realizado ninguna jugada. ¡Anímate a participar! 🎲\n\n' +
                    'Selecciona "🎲 Jugar" en el menú para empezar.',
                    getMainKeyboard(ctx)
                );
            } else {
                const text = buildLastBetsText(bets);
                await safeEdit(ctx, text, getMainKeyboard(ctx));
            }
            return;
        } else if (text === '👥 Referidos') {
            const uid = ctx.from.id;
            const { count } = await supabase
                .from('users')
                .select('*', { count: 'exact', head: true })
                .eq('ref_by', uid);

            const botInfo = await ctx.telegram.getMe();
            const link = `https://t.me/${botInfo.username}?start=${uid}`;

            await safeEdit(ctx,
                `💸 <b>¡GANA DINERO EXTRA INVITANDO AMIGOS! 💰</b>\n\n` +
                `🎯 <b>¿Cómo funciona?</b>\n` +
                `1️⃣ Comparte tu enlace personal con amigos\n` +
                `2️⃣ Cuando se registren y jueguen, tú ganas una comisión\n` +
                `3️⃣ Recibirás un porcentaje de CADA apuesta que realicen\n` +
                `4️⃣ ¡Es automático y para siempre! 🔄\n\n` +
                `🔥 Sin límites, sin topes, sin esfuerzo.\n\n` +
                `📲 <b>Tu enlace mágico:</b> 👇\n` +
                `<code>${escapeHTML(link)}</code>\n\n` +
                `📊 <b>Tus estadísticas:</b>\n` +
                `👥 Referidos registrados: ${count || 0}\n\n` +
                `¡Comparte y empieza a ganar hoy mismo!`,
                getMainKeyboard(ctx)
            );
            return;
        } else if (text === '❓ Cómo jugar') {
            await safeEdit(ctx,
                '📩 <b>¿Necesitas ayuda?</b>\n\n' +
                'Puedes escribirnos directamente en este chat. Nuestro equipo de soporte te responderá a la mayor brevedad.\n\n',
                Markup.inlineKeyboard([[Markup.button.callback('◀ Volver al inicio', 'main')]])
            );
            return;
        } else if (text === '🌐 Abrir Web-App') {
            const webAppButton = Markup.inlineKeyboard([
                Markup.button.webApp('🚀 Abrir Web-App', `${WEBAPP_URL}/app.html`)
            ]);
            await ctx.reply('Haz clic en el botón para acceder a nuestra plataforma web interactiva:', webAppButton);
            return;
        } else if (text === '🔧 Admin' && isAdmin(uid)) {
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>\nSelecciona una opción:', adminPanelKbd());
            return;
        }
    }

    // 3. Manejo de flujos existentes (apuestas, depósitos, etc.)
    // --- Admin: añadir método depósito ---
    if (isAdmin(uid) && session.adminAction === 'add_dep') {
        if (session.adminStep === 1) {
            session.adminTempName = text;
            session.adminStep = 2;
            await ctx.reply('Paso 2/4: Ahora envía la <b>moneda</b> del método (CUP, USD, USDT, TRX, MLC):', { parse_mode: 'HTML' });
            return;
        } else if (session.adminStep === 2) {
            const currency = text.toUpperCase();
            if (!['CUP','USD','USDT','TRX','MLC'].includes(currency)) {
                await ctx.reply('❌ Moneda no válida. Debe ser CUP, USD, USDT, TRX o MLC.');
                return;
            }
            session.adminTempCurrency = currency;
            session.adminStep = 3;
            await ctx.reply('Paso 3/4: Ahora envía el <b>dato principal</b> (número de cuenta, dirección wallet, etc.):', { parse_mode: 'HTML' });
            return;
        } else if (session.adminStep === 3) {
            session.adminTempCard = text;
            session.adminStep = 4;
            await ctx.reply('Paso 4/4: Finalmente, envía el <b>dato de confirmación / red sugerida</b> (para cripto, la red; para otros, número a confirmar):', { parse_mode: 'HTML' });
            return;
        } else if (session.adminStep === 4) {
            const { data, error } = await supabase
                .from('deposit_methods')
                .insert({
                    name: session.adminTempName,
                    currency: session.adminTempCurrency,
                    card: session.adminTempCard,
                    confirm: text
                })
                .select()
                .single();
            if (error) await ctx.reply(`❌ Error al añadir: ${error.message}`);
            else await ctx.reply(`✅ Método de depósito <b>${escapeHTML(session.adminTempName)}</b> (${session.adminTempCurrency}) añadido correctamente con ID ${data.id}.`, { parse_mode: 'HTML' });
            delete session.adminAction;
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
            return;
        }
    }

    // --- Admin: añadir método retiro ---
    if (isAdmin(uid) && session.adminAction === 'add_wit') {
        if (session.adminStep === 1) {
            session.adminTempName = text;
            session.adminStep = 2;
            await ctx.reply('Paso 2/4: Ahora envía la <b>moneda</b> del método (CUP, USD, USDT, TRX, MLC):', { parse_mode: 'HTML' });
            return;
        } else if (session.adminStep === 2) {
            const currency = text.toUpperCase();
            if (!['CUP','USD','USDT','TRX','MLC'].includes(currency)) {
                await ctx.reply('❌ Moneda no válida. Debe ser CUP, USD, USDT, TRX o MLC.');
                return;
            }
            session.adminTempCurrency = currency;
            session.adminStep = 3;
            await ctx.reply('Paso 3/4: Ahora envía el <b>dato principal</b> (instrucciones, número de cuenta, etc.):', { parse_mode: 'HTML' });
            return;
        } else if (session.adminStep === 3) {
            session.adminTempCard = text;
            session.adminStep = 4;
            await ctx.reply('Paso 4/4: Finalmente, envía el <b>dato de confirmación / red sugerida</b> (para cripto, la red; para otros, número a confirmar):', { parse_mode: 'HTML' });
            return;
        } else if (session.adminStep === 4) {
            const { data, error } = await supabase
                .from('withdraw_methods')
                .insert({
                    name: session.adminTempName,
                    currency: session.adminTempCurrency,
                    card: session.adminTempCard,
                    confirm: text
                })
                .select()
                .single();
            if (error) await ctx.reply(`❌ Error al añadir: ${error.message}`);
            else await ctx.reply(`✅ Método de retiro <b>${escapeHTML(session.adminTempName)}</b> (${session.adminTempCurrency}) añadido correctamente con ID ${data.id}.`, { parse_mode: 'HTML' });
            delete session.adminAction;
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
            return;
        }
    }

    // --- Admin: editar método (awaiting_value) ---
    if (isAdmin(uid) && session.adminAction === 'edit_method' && session.editStep === 'awaiting_value') {
        const newValue = text;
        const methodId = session.editMethodId;
        const field = session.editField;
        const type = session.editMethodType;
        const table = type === 'deposit' ? 'deposit_methods' : 'withdraw_methods';

        let updateValue;
        if (field === 'min_amount' || field === 'max_amount') {
            const num = parseFloat(newValue);
            if (isNaN(num) || num < 0) {
                await ctx.reply('❌ Valor inválido. Debe ser un número positivo o 0.');
                return;
            }
            updateValue = num === 0 ? null : num;
        } else {
            updateValue = newValue;
        }

        const updateData = {};
        updateData[field] = updateValue;

        const { error } = await supabase.from(table).update(updateData).eq('id', methodId);
        if (error) {
            await ctx.reply(`❌ Error al actualizar: ${error.message}`);
        } else {
            await ctx.reply(`✅ Campo <b>${field}</b> actualizado correctamente.`, { parse_mode: 'HTML' });
        }
        delete session.adminAction;
        delete session.editMethodId;
        delete session.editMethodType;
        delete session.editStep;
        delete session.editField;
        await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
        return;
    }

    // --- Admin: configurar tasa USD ---
    if (isAdmin(uid) && session.adminAction === 'set_rate_usd') {
        const rate = parseFloat(text.replace(',', '.'));
        if (isNaN(rate) || rate <= 0) {
            await ctx.reply('❌ Número inválido. Por favor, envía un número positivo (ej: 120).');
            return;
        }
        await setExchangeRateUSD(rate);
        await ctx.reply(`✅ Tasa USD/CUP actualizada: 1 USD = ${rate} CUP`, { parse_mode: 'HTML' });
        delete session.adminAction;
        await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
        return;
    }

    // --- Admin: configurar tasa MLC ---
    if (isAdmin(uid) && session.adminAction === 'set_rate_mlc') {
        const rate = parseFloat(text.replace(',', '.'));
        if (isNaN(rate) || rate <= 0) {
            await ctx.reply('❌ Número inválido. Por favor, envía un número positivo (ej: 120).');
            return;
        }
        const result = await setExchangeRateMLC(rate);
        if (!result.ok) {
            await ctx.reply('❌ No se pudo actualizar la tasa MLC. Verifica que exista la columna rate_mlc en la tabla exchange_rate.');
            return;
        }
        await ctx.reply(`✅ Tasa MLC/CUP actualizada: 1 MLC = ${rate} CUP`, { parse_mode: 'HTML' });
        delete session.adminAction;
        await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
        return;
    }

    // --- Admin: configurar tasa USDT ---
    if (isAdmin(uid) && session.adminAction === 'set_rate_usdt') {
        const rate = parseFloat(text.replace(',', '.'));
        if (isNaN(rate) || rate <= 0) {
            await ctx.reply('❌ Número inválido. Por favor, envía un número positivo (ej: 110).');
            return;
        }
        await setExchangeRateUSDT(rate);
        await ctx.reply(`✅ Tasa USDT/CUP actualizada: 1 USDT = ${rate} CUP`, { parse_mode: 'HTML' });
        delete session.adminAction;
        await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
        return;
    }

    // --- Admin: configurar tasa TRX ---
    if (isAdmin(uid) && session.adminAction === 'set_rate_trx') {
        const rate = parseFloat(text.replace(',', '.'));
        if (isNaN(rate) || rate <= 0) {
            await ctx.reply('❌ Número inválido. Por favor, envía un número positivo (ej: 1.5).');
            return;
        }
        await setExchangeRateTRX(rate);
        await ctx.reply(`✅ Tasa TRX/CUP actualizada: 1 TRX = ${rate} CUP`, { parse_mode: 'HTML' });
        delete session.adminAction;
        await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
        return;
    }

    // --- Admin: configurar mínimo depósito ---
    if (isAdmin(uid) && session.adminAction === 'set_min_deposit') {
        const value = parseFloat(text.replace(',', '.'));
        if (isNaN(value) || value <= 0) {
            await ctx.reply('❌ Número inválido. Envía un número positivo (ej: 5).');
            return;
        }
        await setMinDepositUSD(value);
        await ctx.reply(`✅ Mínimo de depósito actualizado a: ${value} USD (equivale a ${(value * await getExchangeRateUSD()).toFixed(2)} CUP)`, { parse_mode: 'HTML' });
        delete session.adminAction;
        await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
        return;
    }

    // --- Admin: configurar mínimo retiro ---
    if (isAdmin(uid) && session.adminAction === 'set_min_withdraw') {
        const value = parseFloat(text.replace(',', '.'));
        if (isNaN(value) || value <= 0) {
            await ctx.reply('❌ Número inválido. Envía un número positivo (ej: 2).');
            return;
        }
        await setMinWithdrawUSD(value);
        await ctx.reply(`✅ Mínimo de retiro actualizado a: ${value} USD (equivale a ${(value * await getExchangeRateUSD()).toFixed(2)} CUP)`, { parse_mode: 'HTML' });
        delete session.adminAction;
        await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
        return;
    }

    // --- Admin: configurar precios (set_price) ---
    if (isAdmin(uid) && session.adminAction === 'set_price') {
        if (session.priceStep === 1) {
            const multiplier = parseFloat(text.replace(',', '.'));
            if (isNaN(multiplier) || multiplier < 0) {
                await ctx.reply('❌ Multiplicador inválido. Debe ser un número positivo.');
                return;
            }
            session.priceTempMultiplier = multiplier;
            session.priceStep = 2;
            await ctx.reply(
                `Paso 2/3: Ingresa el <b>monto mínimo en CUP</b> (0 = sin mínimo):`,
                { parse_mode: 'HTML' }
            );
            return;
        } else if (session.priceStep === 2) {
            const minCup = parseFloat(text.replace(',', '.'));
            if (isNaN(minCup) || minCup < 0) {
                await ctx.reply('❌ Monto inválido. Debe ser un número positivo o 0.');
                return;
            }
            session.priceTempMinCup = minCup;
            session.priceStep = 3;
            await ctx.reply(
                `Paso 3/3: Ingresa el <b>monto mínimo en USD</b> (0 = sin mínimo):`,
                { parse_mode: 'HTML' }
            );
            return;
        } else if (session.priceStep === 3) {
            const minUsd = parseFloat(text.replace(',', '.'));
            if (isNaN(minUsd) || minUsd < 0) {
                await ctx.reply('❌ Monto inválido. Debe ser un número positivo o 0.');
                return;
            }
            session.priceTempMinUsd = minUsd;
            session.priceStep = 4;
            await ctx.reply(
                `Paso 4/4: Ingresa el <b>monto máximo en CUP</b> (0 = sin límite):`,
                { parse_mode: 'HTML' }
            );
            return;
        } else if (session.priceStep === 4) {
            const maxCup = parseFloat(text.replace(',', '.'));
            if (isNaN(maxCup) || maxCup < 0) {
                await ctx.reply('❌ Monto inválido. Debe ser un número positivo o 0.');
                return;
            }
            session.priceTempMaxCup = maxCup;
            session.priceStep = 5;
            await ctx.reply(
                `Paso 5/5: Ingresa el <b>monto máximo en USD</b> (0 = sin límite):`,
                { parse_mode: 'HTML' }
            );
            return;
        } else if (session.priceStep === 5) {
            const maxUsd = parseFloat(text.replace(',', '.'));
            if (isNaN(maxUsd) || maxUsd < 0) {
                await ctx.reply('❌ Monto inválido. Debe ser un número positivo o 0.');
                return;
            }
            const betType = session.betType;
            await supabase
                .from('play_prices')
                .update({
                    payout_multiplier: session.priceTempMultiplier,
                    min_cup: session.priceTempMinCup,
                    min_usd: session.priceTempMinUsd,
                    max_cup: session.priceTempMaxCup === 0 ? null : session.priceTempMaxCup,
                    max_usd: maxUsd === 0 ? null : maxUsd,
                    updated_at: new Date()
                })
                .eq('bet_type', betType);
            await ctx.reply(
                `✅ Precios para <b>${betType}</b> actualizados:\n` +
                `🎁 Multiplicador: x${session.priceTempMultiplier}\n` +
                `📉 Mín: ${session.priceTempMinCup} CUP / ${session.priceTempMinUsd} USD\n` +
                `📈 Máx: ${session.priceTempMaxCup || '∞'} CUP / ${maxUsd || '∞'} USD`,
                { parse_mode: 'HTML' }
            );
            delete session.adminAction;
            delete session.priceStep;
            delete session.priceTempMultiplier;
            delete session.priceTempMinCup;
            delete session.priceTempMinUsd;
            delete session.priceTempMaxCup;
            delete session.betType;
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
            return;
        }
    }

    // --- Admin: configurar mínimos por jugada (set_min) ---
    if (isAdmin(uid) && session.adminAction === 'set_min') {
        if (session.minStep === 1) {
            const minCup = parseFloat(text.replace(',', '.'));
            if (isNaN(minCup) || minCup < 0) {
                await ctx.reply('❌ Monto inválido. Debe ser un número positivo o 0.');
                return;
            }
            session.minTempCup = minCup;
            session.minStep = 2;
            await ctx.reply(
                `Paso 2/4: Ingresa el <b>monto mínimo en USD</b> (0 = sin mínimo):`,
                { parse_mode: 'HTML' }
            );
            return;
        } else if (session.minStep === 2) {
            const minUsd = parseFloat(text.replace(',', '.'));
            if (isNaN(minUsd) || minUsd < 0) {
                await ctx.reply('❌ Monto inválido. Debe ser un número positivo o 0.');
                return;
            }
            session.minTempUsd = minUsd;
            session.minStep = 3;
            await ctx.reply(
                `Paso 3/4: Ingresa el <b>monto máximo en CUP</b> (0 = sin límite):`,
                { parse_mode: 'HTML' }
            );
            return;
        } else if (session.minStep === 3) {
            const maxCup = parseFloat(text.replace(',', '.'));
            if (isNaN(maxCup) || maxCup < 0) {
                await ctx.reply('❌ Monto inválido. Debe ser un número positivo o 0.');
                return;
            }
            session.maxTempCup = maxCup;
            session.minStep = 4;
            await ctx.reply(
                `Paso 4/4: Ingresa el <b>monto máximo en USD</b> (0 = sin límite):`,
                { parse_mode: 'HTML' }
            );
            return;
        } else if (session.minStep === 4) {
            const maxUsd = parseFloat(text.replace(',', '.'));
            if (isNaN(maxUsd) || maxUsd < 0) {
                await ctx.reply('❌ Monto inválido. Debe ser un número positivo o 0.');
                return;
            }
            const betType = session.betType;
            await supabase
                .from('play_prices')
                .update({
                    min_cup: session.minTempCup,
                    min_usd: session.minTempUsd,
                    max_cup: session.maxTempCup === 0 ? null : session.maxTempCup,
                    max_usd: maxUsd === 0 ? null : maxUsd,
                    updated_at: new Date()
                })
                .eq('bet_type', betType);
            await ctx.reply(
                `✅ Límites para <b>${betType}</b> actualizados:\n` +
                `📉 Mín: ${session.minTempCup} CUP / ${session.minTempUsd} USD\n` +
                `📈 Máx: ${session.maxTempCup || '∞'} CUP / ${maxUsd || '∞'} USD`,
                { parse_mode: 'HTML' }
            );
            delete session.adminAction;
            delete session.minStep;
            delete session.minTempCup;
            delete session.minTempUsd;
            delete session.maxTempCup;
            delete session.betType;
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
            return;
        }
    }

    // --- Admin: publicar número ganador ---
    if (isAdmin(uid) && session.adminAction === 'winning_numbers') {
        const sessionId = session.winningSessionId;
        const success = await processWinningNumber(sessionId, text, ctx);
        if (success) {
            delete session.adminAction;
            delete session.winningSessionId;
            await safeEdit(ctx, '🔧 <b>Panel de administración</b>', adminPanelKbd());
        }
        return;
    }

    // --- Flujo: depósito (awaitingDepositAmount) ---
    if (session.awaitingDepositAmount) {
        const amountText = text;
        const method = session.depositMethod;

        const parsed = parseAmountWithCurrency(amountText);
        if (!parsed) {
            await ctx.reply('❌ Formato inválido. Debes escribir el monto seguido de la moneda (ej: 500 cup o 10 usdt, etc).', getMainKeyboard(ctx));
            return;
        }

        if (parsed.currency !== method.currency) {
            await ctx.reply(`❌ La moneda del monto (${parsed.currency}) no coincide con la del método (${method.currency}). Por favor, envía el monto en ${method.currency}.`, getMainKeyboard(ctx));
            return;
        }

        const methodMinAmount = method.min_amount !== null && !Number.isNaN(parseFloat(method.min_amount)) ? parseFloat(method.min_amount) : null;
        const methodMaxAmount = method.max_amount !== null && !Number.isNaN(parseFloat(method.max_amount)) ? parseFloat(method.max_amount) : null;
        if (methodMinAmount !== null && parsed.amount < methodMinAmount) {
            await ctx.reply(
                `❌ El monto mínimo de depósito aceptado es ${methodMinAmount} ${parsed.currency}.`,
                getMainKeyboard(ctx)
            );
            return;
        }

        if (methodMaxAmount !== null && !Number.isNaN(methodMaxAmount) && parsed.amount > methodMaxAmount) {
            await ctx.reply(
                `❌ Monto máximo: ${methodMaxAmount} ${parsed.currency}.`,
                getMainKeyboard(ctx)
            );
            return;
        }

        // Guardamos el monto validado y pedimos la captura (mensaje simplificado según especificación)
        session.depositAmountText = amountText;
        session.depositParsed = parsed;
        delete session.awaitingDepositAmount;
        session.awaitingDepositPhoto = true;

        // Mensaje unificado para todos los métodos de depósito
        let header = `🧾 ${escapeHTML(method.name)}`;
        if (method.currency && method.currency.trim()) {
            header += ` \nMoneda: ${escapeHTML(method.currency)}`;
        }

        await safeEdit(ctx,
            `${header}\n\n\n📸 Ahora, por favor, envía una captura de pantalla de la transferencia que realizaste.\n(Asegúrate de que se vea claramente el monto, la moneda y, para cripto, el hash)`,
            null
        );

        return;
    }

    // --- Flujo: retiro (pasos intermedios) ---
    // Paso 1: tarjeta / dato inicial (awaitingWithdrawAccountCard)
    if (session.awaitingWithdrawAccountCard) {
        const card = text.trim();
        if (!card) {
            await ctx.reply('❌ El dato no puede estar vacío. Por favor, ingresa la tarjeta o dato solicitado.', getMainKeyboard(ctx));
            return;
        }
        session.withdrawAccountCard = card;
        // No persistir en la base de datos: mantener el dato en la sesión
        delete session.awaitingWithdrawAccountCard;
        session.awaitingWithdrawAccountMobile = true;

        // Intentar usar plantilla para pedir el móvil si existe
        const method = session.withdrawMethod;
        const methodMin = method && method.min_amount !== null && method.min_amount !== undefined ? parseFloat(method.min_amount) : 0;
        let balanceForTemplate = '0.00';
        if (method) {
            const cupBalance = parseFloat(user.cup) || 0;
            const usdBalance = parseFloat(user.usd) || 0;
            const rateUSD = await getExchangeRateUSD();
            const totalAvailableCUP = cupBalance + (usdBalance * rateUSD);
            if (method.currency === 'USD') {
                // Mostrar solo saldo USD para retiros en USD
                balanceForTemplate = usdBalance.toFixed(2);
            } else {
                const equivalente = await convertFromCUP(totalAvailableCUP, method.currency);
                balanceForTemplate = equivalente.toFixed(2);
            }
        }
        const currencyCode = session.withdrawTemplateKey || (method ? canonicalizeCurrency(method.currency) : '');
        let templates = method ? getWithdrawalTemplate(currencyCode, balanceForTemplate, methodMin, method.currency) : null;
        if (!templates || templates.length < 2) {
            // No usar fallback: cancelar flujo y notificar al usuario
            delete session.awaitingWithdrawAccountCard;
            delete session.withdrawMethod;
            delete session.withdrawTemplateKey;
            delete session.withdrawFlowAllowed;
            await ctx.reply(`⚠️ El método seleccionado (${escapeHTML(method.name)} - ${escapeHTML(method.currency)}) no tiene plantilla válida para continuar. Por favor, contacta al administrador.`, getMainKeyboard(ctx));
            return;
        }
        await ctx.reply(templates[1], { parse_mode: 'HTML' });
        return;
    }

    // Paso 2: móvil / segundo dato (awaitingWithdrawAccountMobile)
    if (session.awaitingWithdrawAccountMobile) {
        const mobile = text.trim();
        if (!mobile) {
            await ctx.reply('❌ El móvil no puede estar vacío. Por favor, ingresa un número de móvil válido.', getMainKeyboard(ctx));
            return;
        }
        session.withdrawAccountMobile = mobile;
        // No persistir en la base de datos: mantener el dato en la sesión
        delete session.awaitingWithdrawAccountMobile;
        // Ahora pedir el monto
        session.awaitingWithdrawAmount = true;

        const method = session.withdrawMethod;
        const methodMin = method && method.min_amount !== null && method.min_amount !== undefined ? parseFloat(method.min_amount) : 0;
        let balanceForTemplate = '0.00';
        if (method) {
            const cupBalance = parseFloat(user.cup) || 0;
            const usdBalance = parseFloat(user.usd) || 0;
            const rateUSD = await getExchangeRateUSD();
            const totalAvailableCUP = cupBalance + (usdBalance * rateUSD);
            if (method.currency === 'USD') {
                balanceForTemplate = usdBalance.toFixed(2);
            } else {
                const equivalente = await convertFromCUP(totalAvailableCUP, method.currency);
                balanceForTemplate = equivalente.toFixed(2);
            }
        }
        const currencyCode = session.withdrawTemplateKey || (method ? canonicalizeCurrency(method.currency) : '');
        let templates = method ? getWithdrawalTemplate(currencyCode, balanceForTemplate, methodMin, method.currency) : null;
        let instruccionesAdicionales = '';
        if (method && (method.currency === 'USDT' || method.currency === 'TRX')) {
            instruccionesAdicionales = `\n\n🔐 <b>Para retiros en ${method.currency}:</b>\n- Después de confirmar el monto, te pediré por separado:\n   • Dirección de wallet\n   • Red (ej: TRC-20 para USDT, sugerida: ${method.confirm !== 'ninguno' ? method.confirm : 'la que corresponda'})\n- Asegúrate de usar la red correcta para evitar pérdidas.`;
        }
        if (!templates || templates.length < 3) {
            // No usar fallback: cancelar flujo y notificar al usuario
            delete session.awaitingWithdrawAccountMobile;
            delete session.withdrawMethod;
            delete session.withdrawTemplateKey;
            delete session.withdrawFlowAllowed;
            await ctx.reply(`⚠️ El método seleccionado (${escapeHTML(method.name)} - ${escapeHTML(method.currency)}) no tiene plantilla válida para continuar. Por favor, contacta al administrador.`, getMainKeyboard(ctx));
            return;
        }
        await ctx.reply(templates[2], { parse_mode: 'HTML' });
        return;
    }

    // --- Flujo: retiro (awaitingWithdrawAmount) ---
    if (session.awaitingWithdrawAmount) {
        const amountText = text;
        const method = session.withdrawMethod;
        const currency = method.currency;

        const amount = parseFloat(amountText.replace(',', '.'));
        if (isNaN(amount) || amount <= 0) {
            await ctx.reply('❌ Monto inválido. Por favor, envía un número positivo.', getMainKeyboard(ctx));
            return;
        }

        // Usar exclusivamente el mínimo configurado en el método (sin mínimos globales ni fallbacks)
        const methodMin = method.min_amount !== null && method.min_amount !== undefined ? parseFloat(method.min_amount) : null;
        if (methodMin === null) {
            await ctx.reply('❌ El método de retiro seleccionado no tiene un mínimo configurado. Contacta al administrador.', getMainKeyboard(ctx));
            return;
        }
        if (amount < methodMin) {
            await ctx.reply(`❌ Monto mínimo: ${methodMin} ${currency}`, getMainKeyboard(ctx));
            return;
        }

        const debitPlan = await buildRealBalanceDebitPlan(user, amount, currency);
        if (!debitPlan.ok) {
            await ctx.reply(
                `❌ ${debitPlan.errorMessage || `Saldo real insuficiente para retirar ${amount} ${currency}.\nDisponible total (CUP+USD): ${debitPlan.totalAvailableCUP.toFixed(2)} CUP\nNecesitas: ${debitPlan.amountCUP.toFixed(2)} CUP`}`,
                getMainKeyboard(ctx)
            );
            return;
        }

        if (method.min_amount !== null && amount < method.min_amount) {
            await ctx.reply(`❌ Monto mínimo: ${method.min_amount} ${currency}`, getMainKeyboard(ctx));
            return;
        }
        if (method.max_amount !== null && amount > method.max_amount) {
            await ctx.reply(`❌ Monto máximo: ${method.max_amount} ${currency}`, getMainKeyboard(ctx));
            return;
        }

        // Calcular amountUSD para mostrar y guardar en la base de datos
        let amountUSD = null;
        if (currency === 'USD') {
            amountUSD = amount;
        } else if (currency === 'CUP') {
            const rate = await getExchangeRateUSD();
            amountUSD = amount / rate;
        } else if (currency === 'USDT' || currency === 'TRX' || currency === 'MLC') {
            // Por ahora asumimos 1:1 con USD
            amountUSD = amount;
        }

        session.withdrawAmount = amount;
        session.withdrawCurrency = currency;
        session.withdrawAmountUSD = amountUSD;

        // Dependiendo de la moneda, pedimos los datos de la cuenta
        if (currency === 'USDT' || currency === 'TRX') {
            // If wallet+network already provided in session, create the withdraw immediately
            const existingWallet = session.withdrawWallet;
            const existingNetwork = session.withdrawNetwork;
            if (existingWallet && existingNetwork) {
                const accountInfo = `Wallet: ${existingWallet} (Red: ${existingNetwork})`;
                try {
                    const { data: request, error } = await supabase
                        .from('withdraw_requests')
                        .insert({
                            user_id: uid,
                            method_id: method.id,
                            amount: amount,
                            currency: currency,
                            account_info: accountInfo,
                            status: 'pending',
                            amount_usd: amountUSD
                        })
                        .select()
                        .single();

                    if (error) throw error;

                    for (const adminId of ADMIN_IDS) {
                        try {
                            await ctx.telegram.sendMessage(adminId,
                                `🟨 <b>Nueva solicitud de retiro</b>\n` +
                                `Usuario: ${escapeHTML(ctx.from.first_name)} (${uid})\n` +
                                `Monto: ${amount} ${currency}\n` +
                                `Wallet: ${escapeHTML(existingWallet)}\n` +
                                `Red: ${escapeHTML(existingNetwork)}\n` +
                                `Método: ${escapeHTML(method.name || '')}\n` +
                                `ID solicitud: ${request.id}`,
                                {
                                    parse_mode: 'HTML',
                                    reply_markup: Markup.inlineKeyboard([
                                        [Markup.button.callback('✅ Aprobar', `approve_withdraw_${request.id}`), Markup.button.callback('❌ Rechazar', `reject_withdraw_${request.id}`)]
                                    ]).reply_markup
                                }
                            );
                        } catch (e) {}
                    }

                    await ctx.reply(
                        `✅ <b>Solicitud de retiro enviada</b>\n` +
                        `💰 Monto: ${amount} ${currency}\n` +
                        `📞 Wallet: ${escapeHTML(existingWallet)}\n` +
                        `🔗 Red: ${escapeHTML(existingNetwork)}\n` +
                        `⏳ Procesaremos tu solicitud a la mayor brevedad. Por favor espera a que sea aprobada.`,
                        { parse_mode: 'HTML' }
                    );

                    // Cleanup session
                    delete session.withdrawWallet;
                    delete session.withdrawNetwork;
                    delete session.withdrawMethod;
                    delete session.withdrawTemplateKey;
                    delete session.withdrawAmount;
                    delete session.withdrawCurrency;
                    delete session.withdrawAmountUSD;
                    delete session.awaitingWithdrawAmount;
                    delete session.withdrawFlowAllowed;
                } catch (e) {
                    console.error('Error al crear solicitud de retiro cripto (auto):', e);
                    await ctx.reply(`❌ Error al crear la solicitud: ${e.message}`, getMainKeyboard(ctx));
                }
            } else {
                session.awaitingWithdrawWallet = true; // Nuevo estado para pedir wallet
                delete session.awaitingWithdrawAmount;
                await ctx.reply(
                    `✅ Monto aceptado: ${amount} ${currency} (equivale a ${amountUSD ? amountUSD.toFixed(2) : 'N/A'} USD)\n\n` +
                    `Por favor, escribe tu <b>dirección de wallet</b> para recibir el retiro.\n` +
                    `(Ejemplo: TXYZ... o 0x... según la red)`,
                    { parse_mode: 'HTML' }
                );
            }
        } else {
            // Non-crypto: if account/card or mobile was already provided earlier in the flow,
            // create the withdraw request immediately instead of asking again.
            const existingAccountCard = session.withdrawAccountCard;
            const existingAccountMobile = session.withdrawAccountMobile;
            if (existingAccountCard || existingAccountMobile) {
                const accountInfo = `${existingAccountCard ? `Tarjeta: ${existingAccountCard}` : ''}${existingAccountCard && existingAccountMobile ? ' · ' : ''}${existingAccountMobile ? `Móvil: ${existingAccountMobile}` : ''}`;
                try {
                    const { data: request, error } = await supabase
                        .from('withdraw_requests')
                        .insert({
                            user_id: uid,
                            method_id: method.id,
                            amount: amount,
                            currency: currency,
                            account_info: accountInfo,
                            status: 'pending',
                            amount_usd: amountUSD
                        })
                        .select()
                        .single();

                    if (error) throw error;

                    for (const adminId of ADMIN_IDS) {
                        try {
                                await ctx.telegram.sendMessage(adminId,
                                `🟨 <b>Nueva solicitud de retiro</b>\n` +
                                `Usuario: ${escapeHTML(ctx.from.first_name)} (${uid})\n` +
                                `Monto: ${amount} ${currency}\n` +
                                `Cuenta: ${escapeHTML(accountInfo)}\n` +
                                `Método: ${escapeHTML(method.name || '')}\n` +
                                `ID solicitud: ${request.id}`,
                                {
                                    parse_mode: 'HTML',
                                    reply_markup: Markup.inlineKeyboard([
                                        [Markup.button.callback('✅ Aprobar', `approve_withdraw_${request.id}`), Markup.button.callback('❌ Rechazar', `reject_withdraw_${request.id}`)]
                                    ]).reply_markup
                                }
                            );
                        } catch (e) {}
                    }

                    await ctx.reply(
                        `✅ <b>Solicitud de retiro enviada</b>\n` +
                        `💰 Monto: ${amount} ${currency}\n` +
                        `⏳ Procesaremos tu solicitud a la mayor brevedad. Por favor espera a que sea aprobada.`,
                        { parse_mode: 'HTML' }
                    );

                    // Cleanup session
                    delete session.withdrawAccountCard;
                    delete session.withdrawAccountMobile;
                    delete session.withdrawMethod;
                    delete session.withdrawTemplateKey;
                    delete session.withdrawAmount;
                    delete session.withdrawCurrency;
                    delete session.withdrawAmountUSD;
                    delete session.awaitingWithdrawAmount;
                    delete session.awaitingWithdrawAccount;
                    delete session.withdrawFlowAllowed;
                } catch (e) {
                    console.error('Error al crear solicitud de retiro (auto):', e);
                    await ctx.reply(`❌ Error al crear la solicitud: ${e.message}`, getMainKeyboard(ctx));
                }
            } else {
                // If the user already provided card/mobile earlier in the flow, use those
                // values to create the withdraw request immediately instead of asking again.
                const existingCard = session.withdrawAccountCard;
                const existingMobile = session.withdrawAccountMobile;
                if (existingCard || existingMobile) {
                    const accountInfo = `${existingCard ? `Tarjeta: ${existingCard}` : ''}${existingCard && existingMobile ? ' · ' : ''}${existingMobile ? `Móvil: ${existingMobile}` : ''}`;
                    try {
                        const { data: request, error } = await supabase
                            .from('withdraw_requests')
                            .insert({
                                user_id: uid,
                                method_id: method.id,
                                amount: amount,
                                currency: currency,
                                account_info: accountInfo,
                                status: 'pending',
                                amount_usd: amountUSD
                            })
                            .select()
                            .single();

                        if (error) throw error;

                        // Notify admins
                        for (const adminId of ADMIN_IDS) {
                            try {
                                await ctx.telegram.sendMessage(adminId,
                                    `🟨 <b>Nueva solicitud de retiro</b>\n` +
                                    `Usuario: ${escapeHTML(ctx.from.first_name)} (${uid})\n` +
                                    `Monto: ${amount} ${currency}\n` +
                                    `Cuenta: ${escapeHTML(accountInfo)}\n` +
                                    `Método: ${escapeHTML(method.name || '')}\n` +
                                    `ID solicitud: ${request.id}`,
                                    {
                                        parse_mode: 'HTML',
                                        reply_markup: Markup.inlineKeyboard([
                                            [Markup.button.callback('✅ Aprobar', `approve_withdraw_${request.id}`), Markup.button.callback('❌ Rechazar', `reject_withdraw_${request.id}`)]
                                        ]).reply_markup
                                    }
                                );
                            } catch (e) {}
                        }

                        await ctx.reply(
                            `✅ <b>Solicitud de retiro enviada</b>\n` +
                            `💰 Monto: ${amount} ${currency}\n` +
                            `⏳ Procesaremos tu solicitud a la mayor brevedad. Por favor espera a que sea aprobada.`,
                            { parse_mode: 'HTML' }
                        );

                        // cleanup session fields used for the withdraw flow
                        delete session.withdrawAccountCard;
                        delete session.withdrawAccountMobile;
                        delete session.withdrawMethod;
                        delete session.withdrawTemplateKey;
                        delete session.withdrawAmount;
                        delete session.withdrawCurrency;
                        delete session.withdrawAmountUSD;
                        delete session.awaitingWithdrawAmount;
                        delete session.withdrawFlowAllowed;
                    } catch (e) {
                        console.error('Error creando solicitud de retiro (auto):', e);
                        await ctx.reply(`❌ Error al crear la solicitud: ${e.message}`, getMainKeyboard(ctx));
                    }
                } else {
                    session.awaitingWithdrawAccount = true;
                    delete session.awaitingWithdrawAmount;
                    await ctx.reply(
                        `✅ Monto aceptado: ${amount} ${currency} (equivale a ${amountUSD ? amountUSD.toFixed(2) : 'N/A'} USD)\n\n` +
                        `Por favor, escribe los <b>datos de tu cuenta</b> (número de teléfono, tarjeta, etc.) para recibir el retiro.`,
                        { parse_mode: 'HTML' }
                    );
                }
            }
        }
        return;
    }

    // --- Flujo: retiro cripto - wallet ---
    if (session.awaitingWithdrawWallet) {
        const wallet = text.trim();
        if (!wallet) {
            await ctx.reply('❌ La dirección no puede estar vacía. Por favor, ingresa una dirección válida.', getMainKeyboard(ctx));
            return;
        }
        session.withdrawWallet = wallet;
        delete session.awaitingWithdrawWallet;
        session.awaitingWithdrawNetwork = true;
        // Usar la plantilla definida en withdrawalTemplates (índice 1 = pedir red)
        const method = session.withdrawMethod;
        const methodMin = method && method.min_amount !== null && method.min_amount !== undefined ? parseFloat(method.min_amount) : 0;
        // calcular saldo para plantilla
        let balanceForTemplate = '0.00';
        try {
            const cupBalance = parseFloat(user.cup) || 0;
            const usdBalance = parseFloat(user.usd) || 0;
            const rateUSD = await getExchangeRateUSD();
            const totalAvailableCUP = cupBalance + (usdBalance * rateUSD);
            if (method) {
                if (method.currency === 'USD') {
                    balanceForTemplate = usdBalance.toFixed(2);
                } else {
                    const equivalente = await convertFromCUP(totalAvailableCUP, method.currency);
                    balanceForTemplate = equivalente.toFixed(2);
                }
            }
        } catch (e) {
            console.warn('Error calculando balance para plantilla:', e.message);
        }

        const currencyCode = method ? canonicalizeCurrency(method.currency) : '';
        const templates = method ? getWithdrawalTemplate(currencyCode, balanceForTemplate, methodMin, method.currency) : null;
        if (!templates || templates.length < 2) {
            // No usar fallback: cancelar flujo y notificar al usuario
            delete session.awaitingWithdrawNetwork;
            delete session.withdrawMethod;
            delete session.withdrawTemplateKey;
            delete session.withdrawFlowAllowed;
            await ctx.reply(`⚠️ El método seleccionado (${method ? escapeHTML(method.name) : '??'} - ${method ? escapeHTML(method.currency) : '??'}) no tiene plantilla válida para continuar. Por favor, contacta al administrador.`, getMainKeyboard(ctx));
            return;
        }

        await ctx.reply(templates[1], { parse_mode: 'HTML' });
        return;
    }

    // --- Flujo: retiro cripto - red ---
    if (session.awaitingWithdrawNetwork) {
        const network = text.trim();
        if (!network) {
            await ctx.reply('❌ La red no puede estar vacía. Por favor, ingresa la red.', getMainKeyboard(ctx));
            return;
        }
        // Save network in session and move to asking amount
        session.withdrawNetwork = network;
        delete session.awaitingWithdrawNetwork;
        session.awaitingWithdrawAmount = true;

        const method = session.withdrawMethod;
        const methodMin = method && method.min_amount !== null && method.min_amount !== undefined ? parseFloat(method.min_amount) : 0;
        // calcular saldo para plantilla
        let balanceForTemplate = '0.00';
        try {
            const cupBalance = parseFloat(user.cup) || 0;
            const usdBalance = parseFloat(user.usd) || 0;
            const rateUSD = await getExchangeRateUSD();
            const totalAvailableCUP = cupBalance + (usdBalance * rateUSD);
            if (method) {
                if (method.currency === 'USD') {
                    balanceForTemplate = usdBalance.toFixed(2);
                } else {
                    const equivalente = await convertFromCUP(totalAvailableCUP, method.currency);
                    balanceForTemplate = equivalente.toFixed(2);
                }
            }
        } catch (e) {
            console.warn('Error calculando balance para plantilla:', e.message);
        }

        const currencyCode = method ? canonicalizeCurrency(method.currency) : '';
        const templates = method ? getWithdrawalTemplate(currencyCode, balanceForTemplate, methodMin, method.currency) : null;
        let instruccionesAdicionales = '';
        if (method && (method.currency === 'USDT' || method.currency === 'TRX')) {
            instruccionesAdicionales = `\n\n🔐 <b>Para retiros en ${method.currency}:</b>\n- Después de confirmar el monto, te pediré por separado:\n   • Dirección de wallet\n   • Red (ej: TRC-20 para USDT, sugerida: ${method.confirm !== 'ninguno' ? method.confirm : 'la que corresponda'})\n- Asegúrate de usar la red correcta para evitar pérdidas.`;
        }

        if (templates && templates.length >= 3) {
            await ctx.reply(templates[2], { parse_mode: 'HTML' });
        } else {
            // No usar mensaje por defecto: cancelar flujo y notificar al usuario
            delete session.awaitingWithdrawAmount;
            delete session.withdrawMethod;
            delete session.withdrawTemplateKey;
            delete session.withdrawFlowAllowed;
            await ctx.reply(`⚠️ El método seleccionado (${escapeHTML(method.name)} - ${escapeHTML(method.currency)}) no tiene plantilla válida para continuar. Por favor, contacta al administrador.`, getMainKeyboard(ctx));
            return;
        }
        return;
    }

    // --- Flujo: retiro no cripto - cuenta ---
    if (session.awaitingWithdrawAccount) {
        const accountInfo = text;
        const amount = session.withdrawAmount;
        const currency = session.withdrawCurrency;
        const method = session.withdrawMethod;
        const amountUSD = session.withdrawAmountUSD;
        try {
            const { data: request, error } = await supabase
                .from('withdraw_requests')
                .insert({
                    user_id: uid,
                    method_id: method.id,
                    amount: amount,
                    currency: currency,
                    account_info: accountInfo,
                    status: 'pending',
                    amount_usd: amountUSD
                })
                .select()
                .single();

            if (error) throw error;

            for (const adminId of ADMIN_IDS) {
                try {
                    await bot.telegram.sendMessage(adminId,
                        `📤 <b>Nueva solicitud de RETIRO</b>\n` +
                        `👤 Usuario: ${ctx.from.first_name} (${uid})\n` +
                        `💰 Monto: ${amount} ${currency}\n` +
                        `🏦 Método: ${escapeHTML(method.name)}\n` +
                        `📞 Cuenta: ${escapeHTML(accountInfo)}\n` +
                        `🆔 Solicitud: ${request.id}`,
                        {
                            parse_mode: 'HTML',
                            reply_markup: Markup.inlineKeyboard([
                                [Markup.button.callback('✅ Aprobar', `approve_withdraw_${request.id}`),
                                 Markup.button.callback('❌ Rechazar', `reject_withdraw_${request.id}`)]
                            ]).reply_markup
                        }
                    );
                } catch (e) {}
            }

            await ctx.reply(
                `✅ <b>Solicitud de retiro enviada</b>\n` +
                `💰 Monto: ${amount} ${currency}\n` +
                `⏳ Procesaremos tu solicitud a la mayor brevedad. Te avisaremos cuando esté lista.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            console.error(e);
            await ctx.reply(`❌ Error al crear la solicitud: ${e.message}`, getMainKeyboard(ctx));
        }

        delete session.awaitingWithdrawAccount;
        delete session.withdrawMethod;
        delete session.withdrawTemplateKey;
        delete session.withdrawAmount;
        delete session.withdrawCurrency;
        delete session.withdrawAmountUSD;
        delete session.withdrawFlowAllowed;
        return;
    }

    // --- Flujo: transferencia - destino ---
    if (session.awaitingTransferTarget) {
        try {
            let targetIdentifier = text.trim();
            if (targetIdentifier.startsWith('@')) {
                targetIdentifier = targetIdentifier.slice(1);
            }
            let targetUser = null;
            if (targetIdentifier) {
                const { data: userByUsername } = await supabase
                    .from('users')
                    .select('telegram_id, username, first_name')
                    .eq('username', targetIdentifier)
                    .maybeSingle();
                if (userByUsername) {
                    targetUser = userByUsername;
                } else {
                    const targetId = parseInt(targetIdentifier);
                    if (!isNaN(targetId)) {
                        const { data: userById } = await supabase
                            .from('users')
                            .select('telegram_id, username, first_name')
                            .eq('telegram_id', targetId)
                            .maybeSingle();
                        if (userById) {
                            targetUser = userById;
                        }
                    }
                }
            }

            if (!targetUser) {
                await ctx.reply('❌ Usuario no encontrado. Asegúrate de que el nombre de usuario sea correcto o de que el ID numérico esté registrado.\nPor favor, vuelve a iniciar la operación', getMainKeyboard(ctx));
                delete session.awaitingTransferTarget;
                return;
            }
            if (targetUser.telegram_id === uid) {
                await ctx.reply('❌ No puedes transferirte saldo a ti mismo. Elige otro usuario.\nPor favor, vuelve a iniciar la operación', getMainKeyboard(ctx));
                delete session.awaitingTransferTarget;
                return;
            }

            session.transferTarget = targetUser.telegram_id;
            // Ahora pedir el monto directamente, mostrando el mínimo del método elegido
            const method = session.transferDepositMethod;
            let minLine = (method && method.min_amount !== null && method.min_amount !== undefined) ? `\nMínimo: ${method.min_amount} ${method.currency}` : '';
            session.awaitingTransferAmount = true;
            delete session.awaitingTransferTarget;
            await safeEdit(ctx,
                `📥 <b>Por favor, envía el monto que deseas transferir</b> (ej: <code>500 cup</code> o <code>10 usd</code>).` + minLine,
                null
            );
            return;
        } catch (e) {
            console.error('Error inesperado en transferencia destino:', e);
            await ctx.reply('❌ Error inesperado al buscar el usuario destino. Por favor, intenta de nuevo o contacta soporte.', getMainKeyboard(ctx));
            delete session.awaitingTransferTarget;
            return;
        }
    }

    // --- Flujo: transferencia - monto ---
    if (session.awaitingTransferAmount) {
        const parsed = parseAmountWithCurrency(text);
        if (!parsed) {
            // Si el usuario pone un monto inválido, NO limpiar la sesión, solo pedir de nuevo
            await ctx.reply('❌ Formato inválido. Debe ser monto moneda (ej: 500 cup o 10 usd).', getMainKeyboard(ctx));
            return;
        }
        const amount = parsed.amount;
        const currency = parsed.currency;
        const method = session.transferDepositMethod;
        if (!method) {
            await ctx.reply('❌ No se pudo determinar el método de transferencia. Intenta de nuevo.', getMainKeyboard(ctx));
            return;
        }
        // Validar que la moneda escrita coincida con la del método
        if (currency !== method.currency) {
            await ctx.reply(`❌ La moneda del monto (${currency}) no coincide con la del método (${method.currency}). Por favor, envía el monto en ${method.currency}.`, getMainKeyboard(ctx));
            return;
        }
        const methodMinAmount = method.min_amount !== null && !isNaN(parseFloat(method.min_amount)) ? parseFloat(method.min_amount) : 0;
        if (amount < methodMinAmount) {
            await ctx.reply(`❌ El monto mínimo para transferir es ${methodMinAmount} ${method.currency}.`, getMainKeyboard(ctx));
            return;
        }


        // === FLUJO DE TRANSFERENCIA IGUAL AL BACKEND ===
        // 1. Validar usuario destino
        const targetUserId = session.transferTarget;
        if (!targetUserId) {
            await ctx.reply('❌ Usuario destino no encontrado. Reinicia la transferencia.', getMainKeyboard(ctx));
            return;
        }
        if (targetUserId === uid) {
            await ctx.reply('❌ No puedes transferirte a ti mismo.', getMainKeyboard(ctx));
            return;
        }
        // 2. Obtener usuario destino
        const { data: targetUser, error: targetError } = await supabase
            .from('users')
            .select('*')
            .eq('telegram_id', targetUserId)
            .single();
        if (targetError || !targetUser) {
            await ctx.reply('❌ Usuario destino no encontrado.', getMainKeyboard(ctx));
            return;
        }
        // 3. Validar saldo suficiente: usar saldo real (CUP + USD convertido) cuando corresponda
        let cupDebit = 0, usdDebit = 0;
        try {
            const debitPlan = await buildRealBalanceDebitPlan(user, amount, currency);
            if (!debitPlan.ok) {
                await ctx.reply(debitPlan.errorMessage || '❌ Saldo insuficiente para transferir.', getMainKeyboard(ctx));
                return;
            }
            cupDebit = parseFloat(debitPlan.cupDebit) || 0;
            usdDebit = parseFloat(debitPlan.usdDebit) || 0;
        } catch (e) {
            console.error('Error building debit plan for transfer (bot):', e);
            await ctx.reply('❌ Error al validar saldo. Intenta nuevamente.', getMainKeyboard(ctx));
            return;
        }
        // 4. Debitar origen usando el plan calculado
        const updates = {};
        if (cupDebit && cupDebit > 0) {
            const curCup = parseFloat(user.cup) || 0;
            updates.cup = Math.max(0, curCup - cupDebit);
        }
        if (usdDebit && usdDebit > 0) {
            const curUsd = parseFloat(user.usd) || 0;
            updates.usd = Math.max(0, curUsd - usdDebit);
        }
        updates.updated_at = new Date();
        await supabase.from('users').update(updates).eq('telegram_id', uid);
        // 5. Acreditar destino y migrar bono si corresponde
        let updatedTargetCup = parseFloat(targetUser.cup) || 0;
        let updatedTargetUsd = parseFloat(targetUser.usd) || 0;
        let targetBonusCup = parseFloat(targetUser.bonus_cup) || 0;
        let bonusMovedCup = 0;
        if (currency === 'CUP') {
            updatedTargetCup += amount;
        } else if (currency === 'USD') {
            updatedTargetUsd += amount;
        }
        // Migrar bono si corresponde
        const hadNoMainBalance = (parseFloat(targetUser.cup) === 0 && parseFloat(targetUser.usd) === 0);
        const hadApprovedDeposit = false; // No se consulta aquí por simplicidad
        if (targetBonusCup > 0 && hadNoMainBalance && !hadApprovedDeposit) {
            updatedTargetCup += targetBonusCup;
            bonusMovedCup = targetBonusCup;
        }
        let targetUpdate = {
            cup: updatedTargetCup,
            usd: updatedTargetUsd,
            updated_at: new Date()
        };
        if (bonusMovedCup > 0) targetUpdate.bonus_cup = 0;
        await supabase.from('users').update(targetUpdate).eq('telegram_id', targetUserId);
        // 6. Notificar a ambos usuarios
        // Mensaje de éxito personalizado
        const senderName = ctx.from.first_name || ctx.from.username || String(uid);
        const receiverName = targetUser.first_name || targetUser.username || String(targetUserId);
        await ctx.reply(
            `✅ Transferencia realizada con éxito:\n` +
            `💰 Monto: ${amount} ${currency}\n` +
            `👤 De: ${senderName}\n` +
            `👤 A: ${receiverName}`,
            getMainKeyboard(ctx)
        );
        try {
            let message = `🔄 <b>Has recibido una transferencia</b>\n\n` +
                `👤 De: ${escapeHTML(ctx.from.first_name || ctx.from.username || String(uid))}\n` +
                `💰 Monto: ${amount} ${currency}\n`;
            if (currency === 'USD') {
                message += `ℹ️Con tu saldo USD también puedes transferir en CUP; además retirar en CUP, USDT, TRX o MLC según los métodos disponibles.\n`;
            }
            if (bonusMovedCup > 0) {
                message += `🎁 Tu bono de bienvenida de ${bonusMovedCup.toFixed(2)} CUP se ha movido a tu saldo principal.\n`;
            }
            message += `📊 Saldo actualizado.`;
            await bot.telegram.sendMessage(targetUserId, message, { parse_mode: 'HTML' });
        } catch (e) {/* Silenciar error de notificación */}
        // 7. Limpiar sesión
        delete session.awaitingTransferAmount;
        delete session.transferTarget;
        delete session.transferDepositMethod;
        delete session.transferCurrency;
        return;
    }

    // 4. Si no hay ningún flujo activo, se trata como mensaje de soporte
    // Solo si el usuario no es admin (para evitar que los admins se envíen soporte a sí mismos)
    // --- Flujo: apuesta (awaitingBet) ---
    if (session.awaitingBet) {
        const betType = session.betType;
        const rawText = text;
        const parsed = parseBetMessage(rawText, betType);
        if (!parsed || !parsed.ok) {
            await ctx.reply('❌ Formato inválido. Por favor, formula correctamente tu apuesta', getMainKeyboard(ctx));
            return;
        }

        const playSessionId = session.sessionId;
        if (!playSessionId) {
            await ctx.reply('❌ No se encontró la sesión de juego activa. Por favor inicia de nuevo con 🎲 Jugar.', getMainKeyboard(ctx));
            delete session.awaitingBet;
            return;
        }

        try {
            const totalCUP = parseFloat(parsed.totalCUP || 0);
            const totalUSD = parseFloat(parsed.totalUSD || 0);

            // Obtener los límites/configuración de precio para este tipo de jugada
            const { data: price } = await supabase
                .from('play_prices')
                .select('payout_multiplier, min_cup, min_usd, max_cup, max_usd')
                .eq('bet_type', betType)
                .maybeSingle();

            // Validar mínimos/máximos por número (por item)
            for (const it of parsed.items) {
                if (it.cup && it.cup > 0) {
                    if (price && price.min_cup !== null && price.min_cup !== undefined && it.cup < parseFloat(price.min_cup)) {
                        await ctx.reply(`❌ Mínimo en CUP: ${parseFloat(price.min_cup).toFixed(2)}`, getMainKeyboard(ctx));
                        return;
                    }
                    if (price && price.max_cup !== null && price.max_cup !== undefined && it.cup > parseFloat(price.max_cup)) {
                        await ctx.reply(`❌ Máximo en CUP: ${parseFloat(price.max_cup).toFixed(2)}`, getMainKeyboard(ctx));
                        return;
                    }
                }
                if (it.usd && it.usd > 0) {
                    if (price && price.min_usd !== null && price.min_usd !== undefined && it.usd < parseFloat(price.min_usd)) {
                        await ctx.reply(`❌ Mínimo en USD: ${parseFloat(price.min_usd).toFixed(2)}`, getMainKeyboard(ctx));
                        return;
                    }
                    if (price && price.max_usd !== null && price.max_usd !== undefined && it.usd > parseFloat(price.max_usd)) {
                        await ctx.reply(`❌ Máximo en USD: ${parseFloat(price.max_usd).toFixed(2)}`, getMainKeyboard(ctx));
                        return;
                    }
                }
            }

            // Validar saldos y permitir usar bono_cup junto con cup para pagar jugadas en CUP
            const cupBalance = parseFloat(user.cup) || 0;
            const usdBalance = parseFloat(user.usd) || 0;
            const bonusBalance = parseFloat(user.bonus_cup) || 0;

            if (totalCUP <= 0 && totalUSD <= 0) {
                await ctx.reply('❌ No se detectó monto en CUP ni USD en la jugada.', getMainKeyboard(ctx));
                return;
            }

            // Para CUP permitimos combinar saldo principal + bono
            if (totalCUP > 0) {
                const totalAvailableCUP = cupBalance + bonusBalance;
                if (totalAvailableCUP < totalCUP) {
                    await ctx.reply(`❌ Saldo CUP insuficiente. Por favor, recarga.`, getMainKeyboard(ctx));
                    return;
                }
            }

            if (totalUSD > 0 && usdBalance < totalUSD) {
                await ctx.reply(`❌ Saldo USD insuficiente. Por favor, recarga.`, getMainKeyboard(ctx));
                return;
            }

            // Preparar objeto de actualización sólo con las monedas que cambian
            const updates = { updated_at: new Date() };
            let bonusUsed = 0;
            let cupDebit = 0;
            if (totalCUP > 0) {
                // Preferir debitar del saldo principal CUP y luego del bono
                cupDebit = Math.min(cupBalance, totalCUP);
                const remaining = totalCUP - cupDebit;
                bonusUsed = remaining > 0 ? remaining : 0;
                updates.cup = Math.max(0, cupBalance - cupDebit);
                if (bonusUsed > 0) {
                    updates.bonus_cup = Math.max(0, bonusBalance - bonusUsed);
                }
            }
            if (totalUSD > 0) updates.usd = Math.max(0, usdBalance - totalUSD);

            await supabase.from('users').update(updates).eq('telegram_id', uid);

            // Guardar la jugada
            // Anadidas las nuevas variables de la apuesta
            const { data: betInserted, error: betError } = await supabase
                .from('bets')
                .insert({
                    user_id: uid,
                    session_id: playSessionId,
                    bet_type: betType,
                    items: parsed.items,
                    cost_cup: totalCUP,
                    cost_usd: totalUSD,
                    raw_text: rawText,
                    lottery: session.lottery || null,
                    bonus_used_cup: bonusUsed,
                    placed_at: new Date()
                })
                .select()
                .single();

            if (betError) {
                console.error('Error guardando jugada:', betError);
                await ctx.reply('❌ Error al registrar la jugada. Por favor, intenta de nuevo más tarde.', getMainKeyboard(ctx));
                return;
            }

            // Confirmación al usuario
            let confirmMsg = `✅ <b>Jugada registrada</b>\n\n` +
                `🎰 Lotería: ${escapeHTML(session.lottery || 'N/D')}\n` +
                `🔢 Tipo: ${escapeHTML(formatBetTypeLabel(betType))}\n` +
                `📋 Jugadas: ${escapeHTML(rawText)}\n` +
                `💰 Costo: ${totalCUP.toFixed(2)} CUP / ${totalUSD.toFixed(2)} USD\n\n` +
                `¡Buena suerte! 🍀`;
            if (typeof bonusUsed !== 'undefined' && bonusUsed > 0) {
                confirmMsg += `\n\n🎁 Se usaron ${bonusUsed.toFixed(2)} CUP de tu bono.`;
            }
            await ctx.reply(confirmMsg, { parse_mode: 'HTML' });

            // Limpiar estado de apuesta
            delete session.awaitingBet;
            delete session.betType;
            delete session.sessionId;
            return;
        } catch (e) {
            console.error('Error procesando jugada:', e);
            await ctx.reply('❌ Ocurrió un error al procesar la jugada. Intenta de nuevo.', getMainKeyboard(ctx));
            return;
        }
    }
    if (!isAdmin(uid)) {
        // Reenviar a todos los admins
        for (const adminId of ADMIN_IDS) {
            try {
                await bot.telegram.sendMessage(adminId,
                    `📩 <b>Mensaje de soporte de</b> ${escapeHTML(ctx.from.first_name)} (${uid}):\n\n${escapeHTML(text)}`,
                    {
                        parse_mode: 'HTML',
                        reply_markup: Markup.inlineKeyboard([
                            [Markup.button.callback('📩 Responder', `support_reply_${uid}`)]
                        ]).reply_markup
                    }
                );
            } catch (e) {
                console.warn(`Error enviando soporte a admin ${adminId}:`, e.message);
            }
        }
        await ctx.reply('✅ Tu mensaje ha sido enviado al equipo de soporte. Te responderemos a la brevedad.');
    } else {
        // Si es admin y no está en modo respuesta, ignoramos (o podríamos dar un mensaje)
        await ctx.reply('Usa los botones del menú para navegar.', getMainKeyboard(ctx));
    }
});

// ========== MANEJADOR DE FOTOS ==========
bot.on(message('photo'), async (ctx) => {
    const uid = ctx.from.id;
    const session = ctx.session;

    if (session.awaitingDepositPhoto) {
        const photo = ctx.message.photo.pop();
        const fileId = photo.file_id;
        const fileLink = await ctx.telegram.getFileLink(fileId);
        const response = await axios({ url: fileLink.href, responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');

        const method = session.depositMethod;
        const amountText = session.depositAmountText;
        const parsed = session.depositParsed;

        // Si ya tenemos monto validado, procesamos la solicitud ahora
        if (amountText && parsed && method) {
            try {
                const request = await createDepositRequest(uid, method.id, buffer, amountText, parsed.currency);
                for (const adminId of ADMIN_IDS) {
                    try {
                        await bot.telegram.sendMessage(adminId,
                            `📥 <b>Nueva solicitud de DEPÓSITO</b>\n` +
                            `👤 Usuario: ${escapeHTML(ctx.from.first_name)} (${uid})\n` +
                            `🏦 Método: ${escapeHTML(method.name)} (${escapeHTML(method.currency)})\n` +
                            `💰 Monto: ${escapeHTML(amountText)}\n` +
                            `📎 <a href="${escapeHTML(request.screenshot_url)}">Ver captura</a>\n` +
                            `🆔 Solicitud: ${escapeHTML(String(request.id))}`,
                            {
                                parse_mode: 'HTML',
                                reply_markup: Markup.inlineKeyboard([
                                    [Markup.button.callback('✅ Aprobar', `approve_deposit_${request.id}`),
                                     Markup.button.callback('❌ Rechazar', `reject_deposit_${request.id}`)]
                                ]).reply_markup
                            }
                        );
                    } catch (e) {}
                }
                await ctx.reply(`✅ <b>Solicitud de depósito enviada</b>\nMonto: ${escapeHTML(amountText)}\n⏳ Tu solicitud está siendo procesada. Te notificaremos cuando se acredite.\n\n\n ¡Gracias por confiar en nosotros!`, { parse_mode: 'HTML' });
            } catch (e) {
                console.error(e);
                await ctx.reply('❌ Error al procesar la solicitud. Por favor, intenta más tarde o contacta a soporte.', getMainKeyboard(ctx));
            }

            delete session.awaitingDepositPhoto;
            delete session.depositMethod;
            delete session.depositPhotoBuffer;
            delete session.depositAmountText;
            delete session.depositParsed;
            return;
        }

        // Si no hay monto aún, guardamos la captura y pedimos el monto
        session.depositPhotoBuffer = buffer;
        delete session.awaitingDepositPhoto;
        session.awaitingDepositAmount = true;

        await ctx.reply('✅ Captura recibida correctamente. Ahora, por favor, envía el <b>monto transferido</b> con la moneda (ej: <code>500 cup</code> o <code>10 usd</code>).', { parse_mode: 'HTML' });
        return;
    }

    await ctx.reply('No se esperaba una foto en este momento. Por favor, usa los botones del menú.', getMainKeyboard(ctx));
});

// ========== APROBAR/RECHAZAR DEPÓSITOS Y RETIROS ==========
bot.action(/approve_deposit_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ No autorizado', { show_alert: true });
        return;
    }
    try {
        const requestId = parseInt(ctx.match[1]);
        const { data: request } = await supabase
            .from('deposit_requests')
            .select('*')
            .eq('id', requestId)
            .single();

        if (!request) {
            await ctx.answerCbQuery('Solicitud no encontrada', { show_alert: true });
            return;
        }

        const parsed = parseAmountWithCurrency(request.amount);
        if (!parsed) {
            await ctx.answerCbQuery('Monto no válido en la solicitud', { show_alert: true });
            return;
        }

        const amountCUP = await convertToCUP(parsed.amount, parsed.currency);

        const { data: user } = await supabase
            .from('users')
            .select('cup, usd, bonus_cup')
            .eq('telegram_id', request.user_id)
            .single();

        // Si el depósito es USD, acreditarlo en la parte USD; cualquier otra moneda -> convertir a CUP
        // Check if user had any previously approved deposits (excluding this one)
        const { data: prevApproved } = await supabase
            .from('deposit_requests')
            .select('id')
            .eq('user_id', request.user_id)
            .eq('status', 'approved')
            .neq('id', requestId)
            .limit(1);

        // Consider transfers as "already received balance" too: if user already had any CUP or USD, treat as not-first
        const userCup = parseFloat(user.cup) || 0;
        const userUsd = parseFloat(user.usd) || 0;
        const hadAnyMainBalance = (userCup > 0) || (userUsd > 0);

        const isFirstDeposit = !(prevApproved && prevApproved.length > 0) && !hadAnyMainBalance;

        let bonusMovedCup = 0;

        if (parsed.currency === 'USD') {
            const newUsd = (parseFloat(user.usd) || 0) + parsed.amount;
            await supabase
                .from('users')
                .update({ usd: newUsd, updated_at: new Date() })
                .eq('telegram_id', request.user_id);
        } else {
            const newCup = (parseFloat(user.cup) || 0) + amountCUP;
            await supabase
                .from('users')
                .update({ cup: newCup, updated_at: new Date() })
                .eq('telegram_id', request.user_id);
        }

        if (isFirstDeposit) {
            const bonus = parseFloat(user.bonus_cup) || 0;
            if (bonus > 0) {
                const { data: updatedUser } = await supabase
                    .from('users')
                    .select('cup')
                    .eq('telegram_id', request.user_id)
                    .single();

                const newCupAfterBonus = (parseFloat(updatedUser?.cup) || 0) + bonus;
                await supabase
                    .from('users')
                    .update({ cup: newCupAfterBonus, bonus_cup: 0, updated_at: new Date() })
                    .eq('telegram_id', request.user_id);

                bonusMovedCup = bonus;
            }
        }

        await supabase
            .from('deposit_requests')
            .update({ status: 'approved', updated_at: new Date() })
            .eq('id', requestId);

        await ctx.telegram.sendMessage(
            request.user_id,
            buildDepositApprovedMessage({
                depositedAmountText: request.amount,
                creditedAmount: parsed.currency === 'USD' ? parsed.amount : amountCUP,
                creditedCurrency: parsed.currency === 'USD' ? 'USD' : 'CUP',
                includeUsdFollowup: parsed.currency === 'USD',
                bonusMovedCup,
                showBonusMovedNotice: isFirstDeposit
            }),
            { parse_mode: 'HTML' }
        );

        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('✅ Depósito aprobado y saldo actualizado correctamente.');
        await ctx.answerCbQuery();
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al aprobar. Revisa los logs.', { show_alert: true });
    }
});

bot.action(/reject_deposit_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const requestId = parseInt(ctx.match[1]);
        await supabase
            .from('deposit_requests')
            .update({ status: 'rejected', updated_at: new Date() })
            .eq('id', requestId);

        const { data: request } = await supabase
            .from('deposit_requests')
            .select('user_id')
            .eq('id', requestId)
            .single();

        if (request) {
            await ctx.telegram.sendMessage(
                request.user_id,
                '❌ Depósito rechazado\n\n📌La solicitud no pudo ser procesada. Por favor, contáctanos si crees que esto es un error.',
                { parse_mode: 'HTML' }
            );
        }
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('❌ Depósito rechazado.');
        await ctx.answerCbQuery();
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al rechazar', { show_alert: true });
    }
});

bot.action(/approve_withdraw_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) {
        await ctx.answerCbQuery('⛔ No autorizado', { show_alert: true });
        return;
    }
    try {
        const requestId = parseInt(ctx.match[1]);
        const { data: request } = await supabase
            .from('withdraw_requests')
            .select('*')
            .eq('id', requestId)
            .single();

        if (!request) {
            await ctx.answerCbQuery('Solicitud no encontrada', { show_alert: true });
            return;
        }

        const { data: user } = await supabase
            .from('users')
            .select('cup, usd')
            .eq('telegram_id', request.user_id)
            .single();

        const amount = parseFloat(request.amount) || 0;
        const debitPlan = await buildRealBalanceDebitPlan(user, amount, request.currency);

        if (!debitPlan.ok) {
            await ctx.reply(`❌ ${debitPlan.errorMessage || 'El usuario ya no tiene saldo suficiente para este retiro.'}`);
            return;
        }

        await supabase
            .from('users')
            .update({
                cup: (parseFloat(user.cup) || 0) - debitPlan.cupDebit,
                usd: (parseFloat(user.usd) || 0) - debitPlan.usdDebit,
                updated_at: new Date()
            })
            .eq('telegram_id', request.user_id);

        await supabase
            .from('withdraw_requests')
            .update({ status: 'approved', updated_at: new Date() })
            .eq('id', requestId);

        await ctx.telegram.sendMessage(request.user_id,
            `✅ <b>Retiro aprobado</b>\n\n` +
            `💰 Monto retirado: ${request.amount} ${request.currency}\n` +
            `💵 Se debitaron ${debitPlan.cupDebit.toFixed(2)} CUP y ${debitPlan.usdDebit.toFixed(2)} USD de tu saldo real.\n\n` +
            `En breve los fondos serán enviados a tu cuenta.`,
            { parse_mode: 'HTML' }
        );

        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('✅ Retiro aprobado y saldo debitado correctamente.');
        await ctx.answerCbQuery();
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al aprobar', { show_alert: true });
    }
});

bot.action(/reject_withdraw_(\d+)/, async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    try {
        const requestId = parseInt(ctx.match[1]);
        await supabase.from('withdraw_requests').update({ status: 'rejected', updated_at: new Date() }).eq('id', requestId);
        const { data: request } = await supabase.from('withdraw_requests').select('user_id').eq('id', requestId).single();
        if (request) {
            await ctx.telegram.sendMessage(request.user_id,
                '❌ <b>Retiro rechazado</b>\nTu solicitud no pudo ser procesada. Por favor, contacta al administrador para más detalles.',
                { parse_mode: 'HTML' }
            );
        }
        await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
        await ctx.reply('❌ Retiro rechazado.');
        await ctx.answerCbQuery();
    } catch (e) {
        console.error(e);
        await ctx.answerCbQuery('❌ Error al rechazar', { show_alert: true });
    }
});

// ========== CRON JOBS ==========
async function closeExpiredSessions() {
    try {
        const now = new Date().toISOString();
        const { data: expiredSessions } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('status', 'open')
            .lt('end_time', now);

        for (const session of expiredSessions || []) {
            await supabase
                .from('lottery_sessions')
                .update({ status: 'closed', updated_at: new Date() })
                .eq('id', session.id);

            const region = regionMap[session.lottery];
            await broadcastToAllUsers(
                `🔴 <b>SESIÓN CERRADA</b>\n\n` +
                `🎰 ${region?.emoji || '🎰'} <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
                `📅 Fecha: ${session.date}\n\n` +
                `❌ Ya no se reciben más apuestas para esta sesión.\n` +
                `🔢 Pronto anunciaremos el número ganador. ¡Mantente atento!`
            );
        }
    } catch (e) {
        console.error('Error cerrando sesiones:', e);
    }
}

async function openScheduledSessions() {
    try {
        const now = moment.tz(TIMEZONE);
        const today = now.format('YYYY-MM-DD');
        const currentMinutes = now.hours() * 60 + now.minutes();

        const regions = ['Florida', 'Georgia', 'Nueva York'];
        for (const lottery of regions) {
            const region = regionMap[lottery];
            const schedule = getAllowedHours(region.key);
            if (!schedule) continue;

            for (const slot of schedule.slots) {
                const startMinutes = slot.start * 60;
                if (currentMinutes >= startMinutes && currentMinutes < startMinutes + 5) {
                    const { data: existing } = await supabase
                        .from('lottery_sessions')
                        .select('id')
                        .eq('lottery', lottery)
                        .eq('date', today)
                        .eq('time_slot', slot.name)
                        .maybeSingle();

                    if (!existing) {
                        const endTime = getEndTimeFromSlot(lottery, slot.name);
                        if (endTime) {
                            await supabase
                                .from('lottery_sessions')
                                .insert({
                                    lottery,
                                    date: today,
                                    time_slot: slot.name,
                                    status: 'open',
                                    end_time: endTime.toISOString()
                                });

                            await broadcastToAllUsers(
                                `🎲 <b>¡SESIÓN ABIERTA!</b> 🎲\n\n` +
                                `✨ La región ${region.emoji} <b>${escapeHTML(lottery)}</b> ha abierto su turno de <b>${escapeHTML(slot.name)}</b>.\n` +
                                `💎 ¡Es tu momento! Realiza tus apuestas y llévate grandes premios.\n\n` +
                                `⏰ Cierre: ${moment(endTime).tz(TIMEZONE).format('HH:mm')} (hora Cuba)\n` +
                                `🍀 ¡La suerte te espera!`
                            );
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error('Error abriendo sesiones:', e);
    }
}

async function withdrawNotifications() {
    const now = moment.tz(TIMEZONE);
    const currentHour = now.hour();
    const currentMinute = now.minute();

    if (currentHour === 22 && currentMinute === 0) {
        await broadcastToAllUsers(
            `⏰ <b>Horario de Retiros ABIERTO</b>\n\n` +
            `Ya puedes solicitar tus retiros de 10:00 PM a 11:30 PM (hora Cuba).\n` +
            `Puedes retirar en CUP, USD, USDT, TRX o MLC según los métodos disponibles.`,
            'HTML'
        );
    } else if (currentHour === 23 && currentMinute === 30) {
        await broadcastToAllUsers(
            `⏰ <b>Horario de Retiros CERRADO</b>\n\n` +
            `La ventana de retiros ha finalizado. Vuelve mañana de 10:00 PM a 11:30 PM (hora Cuba).`,
            'HTML'
        );
    }
}

cron.schedule('* * * * *', () => {
    closeExpiredSessions();
    openScheduledSessions();
    withdrawNotifications();
}, { timezone: TIMEZONE });

module.exports = bot;
