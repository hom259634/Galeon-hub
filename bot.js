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
const WITHDRAW_HOURS = { start: 22, end: 23.5 };

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
bot.telegram.setMyCommands([
  { command: 'start', description: '🏠 Inicio' },
  { command: 'jugar', description: '🎲 Jugar' },
  { command: 'mi_dinero', description: '💰 Mi dinero' },
  { command: 'mis_jugadas', description: '📋 Mis jugadas' },
  { command: 'referidos', description: '👥 Referidos' },
  { command: 'ayuda', description: '❓ Ayuda' },
  { command: 'webapp', description: '🌐 Abrir WebApp' }
]).catch(err => console.error('Error al setear comandos:', err));

// ========== SESIÓN LOCAL ==========
const localSession = new LocalSession({ database: 'session_db.json' });
bot.use(localSession.middleware());

// ========== FUNCIÓN PARA VERIFICAR SI UN USUARIO ES ADMIN ==========
function isAdmin(userId) {
    return ADMIN_IDS.includes(userId);
}

// ========== FUNCIONES AUXILIARES ==========

function escapeHTML(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
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

async function convertToCUP(amount, currency) {
    const rates = await getExchangeRates();
    switch (currency) {
        case 'CUP': return amount;
        case 'USD': return amount * rates.rate;
        case 'USDT': return amount * rates.rate_usdt;
        case 'TRX': return amount * rates.rate_trx;
        case 'MLC': return amount * rates.rate;
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
        case 'MLC': return amountCUP / rates.rate;
        default: return 0;
    }
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
            return { cup: 0, usd: 0, bonus_cup: 0, first_name: firstName, username, telegram_id: telegramId };
        }

        if (user) {
            if (username && user.username !== username) {
                await supabase.from('users').update({ username }).eq('telegram_id', telegramId);
            }
            return user;
        }

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
            const { data: retryUser } = await supabase
                .from('users')
                .select('*')
                .eq('telegram_id', telegramId)
                .maybeSingle();
            if (retryUser) return retryUser;
            return { cup: 0, usd: 0, bonus_cup: BONUS_CUP_DEFAULT, first_name: firstName, username, telegram_id: telegramId };
        }

        // Si hay contexto, marcamos que es nuevo para enviar el bono después de la bienvenida
        if (ctx && ctx.session) {
            ctx.session.newUserBonus = true;
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

function parseBetLine(line, betType) {
    line = line.trim().toLowerCase();
    if (!line) return [];

    const match = line.match(/^([\d\s,]+)\s*(?:con|\*)\s*([0-9.]+)\s*(usd|cup)?$/i);
    if (!match) return [];

    let numerosStr = match[1].trim();
    const montoStr = match[2];
    const moneda = (match[3] || 'usd').toLowerCase();

    const numeros = numerosStr.split(/[\s,]+/).filter(n => n.length > 0);
    const montoBase = parseFloat(montoStr);
    if (isNaN(montoBase) || montoBase <= 0) return [];

    const resultados = [];

    for (let numero of numeros) {
        let montoReal = montoBase;
        let numeroGuardado = numero;

        if (betType === 'fijo') {
            if (/^\d{2}$/.test(numero)) {
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
            usd: moneda === 'usd' ? montoReal : 0,
            cup: moneda === 'cup' ? montoReal : 0
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

    for (const u of users || []) {
        try {
            await bot.telegram.sendMessage(u.telegram_id, message, { parse_mode: parseMode });
            await new Promise(resolve => setTimeout(resolve, 30));
        } catch (e) {
            console.warn(`Error enviando broadcast a ${u.telegram_id}:`, e.message);
        }
    }
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
        // Determinar monto acreditado y moneda para el mensaje
        let creditedAmount = 0;
        let creditedCurrency = 'CUP';
        if (parsed.currency === 'CUP') {
            creditedAmount = parsed.amount;
            creditedCurrency = 'CUP';
        } else if (parsed.currency === 'USD') {
            creditedAmount = parsed.amount;
            creditedCurrency = 'USD';
        } else {
            creditedAmount = amountCUP;
            creditedCurrency = 'CUP';
        }

        await ctx.telegram.sendMessage(request.user_id,
            `✅ <b>Depósito aprobado</b>\n\n` +
            `💰 Monto depositado: ${request.amount}\n` +
            `💵 Se acreditaron <b>${parseFloat(creditedAmount).toFixed(2)} ${creditedCurrency}</b> a tu saldo.\n\n` +
            `¡Gracias por confiar en nosotros!`,
            { parse_mode: 'HTML' }
        );

function playLotteryKbd() {
    const buttons = [
        [Markup.button.callback('🦩 Florida', 'lot_florida')],
        [Markup.button.callback('🍑 Georgia', 'lot_georgia')],
        [Markup.button.callback('🗽 Nueva York', 'lot_newyork')],
        [Markup.button.callback('◀ Volver', 'main')]
    ];
    return Markup.inlineKeyboard(buttons);
}

function getMainKeyboard(ctx) {
    const isAdm = ctx && ctx.from && isAdmin(ctx.from.id);
    const buttons = [
        [Markup.button.callback('🎲 Jugar', 'play')],
        [Markup.button.callback('📋 Mis jugadas', 'mis_jugadas'), Markup.button.callback('📥 Recargar', 'recharge')],
        [Markup.button.callback('📤 Retirar', 'withdraw'), Markup.button.callback('💰 Mi dinero', 'my_money')],
        [Markup.button.callback('👥 Referidos', 'referidos'), Markup.button.callback('🌐 WebApp', 'webapp')],
        [Markup.button.callback('❓ Ayuda', 'ayuda')]
    ];
    if (isAdm) {
        buttons.splice(4, 0, [Markup.button.callback('🛠️ Admin', 'admin')]);
    }
    return Markup.inlineKeyboard(buttons);
}

function playTypeKbd() {
    const buttons = [
        [Markup.button.callback('🎯 Fijo', 'type_fijo')],
        [Markup.button.callback('🏃 Corridos', 'type_corridos')],
        [Markup.button.callback('💯 Centena', 'type_centena')],
        [Markup.button.callback('🔒 Parle', 'type_parle')],
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
        [Markup.button.callback('🎰 Gestionar sesiones', 'admin_sessions')],
        [Markup.button.callback('🔢 Publicar ganadores', 'admin_winning')],
        [Markup.button.callback('➕ Añadir método DEPÓSITO', 'adm_add_dep')],
        [Markup.button.callback('✏️ Editar método DEPÓSITO', 'adm_edit_dep')],
        [Markup.button.callback('🗑 Eliminar método DEPÓSITO', 'adm_delete_dep')],
        [Markup.button.callback('➕ Añadir método RETIRO', 'adm_add_wit')],
        [Markup.button.callback('✏️ Editar método RETIRO', 'adm_edit_wit')],
        [Markup.button.callback('🗑 Eliminar método RETIRO', 'adm_delete_wit')],
        [Markup.button.callback('💰 Configurar tasa USD/CUP', 'adm_set_rate_usd')],
        [Markup.button.callback('💰 Configurar tasa USDT/CUP', 'adm_set_rate_usdt')],
        [Markup.button.callback('💰 Configurar tasa TRX/CUP', 'adm_set_rate_trx')],
        [Markup.button.callback('🎲 Configurar precios y pagos', 'adm_set_prices')],
        [Markup.button.callback('💰 Mínimos por jugada', 'adm_min_per_bet')],
        [Markup.button.callback('💰 Mínimo depósito', 'adm_min_deposit')],
        [Markup.button.callback('💰 Mínimo retiro', 'adm_min_withdraw')],
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
            ctx.dbUser = user || { cup: 0, usd: 0, bonus_cup: 0 };
        } catch (e) {
            console.error('Error cargando usuario en middleware:', e);
            ctx.dbUser = { cup: 0, usd: 0, bonus_cup: 0 };
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

    // Si es un usuario nuevo, enviamos el bono después de la bienvenida
    if (ctx.session && ctx.session.newUserBonus) {
        try {
            await ctx.reply(
                `🎁 <b>¡Bono de bienvenida!</b>\n\n` +
                `Has recibido <b>${BONUS_CUP_DEFAULT} CUP</b> como bono no retirable.\n` +
                `Puedes usar este bono para jugar y ganar premios reales. ¡Buena suerte!`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            console.error('Error enviando mensaje de bono:', e);
        }
        delete ctx.session.newUserBonus; // Limpiar bandera
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
        `🇨🇺 <b>CUP:</b> ${cup.toFixed(2)} (aprox. ${cupToUsd} USD)\n` +
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
        let text = '📋 <b>Tus últimas 5 jugadas:</b>\n\n';
        const inlineRows = [];
        bets.forEach((b, i) => {
            const date = moment(b.placed_at).tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
            text += `<b>${i + 1}.</b> 🎰 ${escapeHTML(b.lottery)} - ${escapeHTML(b.bet_type)}\n` +
                `   📝 <code>${escapeHTML(b.raw_text)}</code>\n` +
                `   💰 ${b.cost_cup} CUP / ${b.cost_usd} USD\n` +
                `   🕒 ${date}\n\n`;

            // Añadir fila de botones para cada jugada
            inlineRows.push([
                Markup.button.callback('✏️ Editar', `edit_bet_${b.id}`),
                Markup.button.callback('❌ Cancelar', `cancel_bet_${b.id}`)
            ]);
        });
        text += '¿Quieres ver más? Puedes consultar el historial completo en la WebApp.';
        const keyboard = Markup.inlineKeyboard(inlineRows.concat([[Markup.button.callback('◀ Volver', 'main')]])).reply_markup;
        await safeEdit(ctx, text, keyboard);
    }
});

// Acción: iniciar edición de apuesta
bot.action(/edit_bet_(\d+)/, async (ctx) => {
    const uid = ctx.from.id;
    const betId = parseInt(ctx.match[1]);
    const { data: bet } = await supabase.from('bets').select('*').eq('id', betId).maybeSingle();
    if (!bet) { await ctx.answerCbQuery('Jugada no encontrada', { show_alert: true }); return; }
    if (parseInt(bet.user_id) !== parseInt(uid)) { await ctx.answerCbQuery('No autorizado', { show_alert: true }); return; }
    if (bet.session_id) {
        const { data: session } = await supabase.from('lottery_sessions').select('status').eq('id', bet.session_id).maybeSingle();
        if (!session || session.status !== 'open') { await ctx.answerCbQuery('No se puede editar: sesión cerrada', { show_alert: true }); return; }
    }
    ctx.session.awaitingBetEdit = true;
    ctx.session.editingBetId = betId;
    ctx.session.betType = bet.bet_type;
    ctx.session.lottery = bet.lottery;
    ctx.session.sessionId = bet.session_id;
    await ctx.reply('✏️ Envíame el nuevo texto de la jugada EXACTAMENTE con el formato original. Se actualizará la jugada seleccionada.');
    await ctx.answerCbQuery();
});

// Acción: cancelar apuesta desde el bot
bot.action(/cancel_bet_(\d+)/, async (ctx) => {
    const uid = ctx.from.id;
    const betId = parseInt(ctx.match[1]);
    const { data: bet } = await supabase.from('bets').select('*').eq('id', betId).maybeSingle();
    if (!bet) { await ctx.answerCbQuery('Jugada no encontrada', { show_alert: true }); return; }
    if (parseInt(bet.user_id) !== parseInt(uid)) { await ctx.answerCbQuery('No autorizado', { show_alert: true }); return; }
    if (bet.session_id) {
        const { data: session } = await supabase.from('lottery_sessions').select('status').eq('id', bet.session_id).maybeSingle();
        if (!session || session.status !== 'open') { await ctx.answerCbQuery('No se puede cancelar: sesión cerrada', { show_alert: true }); return; }
    }

    const user = await getOrCreateUser(parseInt(uid));
    let newCup = parseFloat(user.cup) || 0;
    let newUsd = parseFloat(user.usd) || 0;
    let newBonus = parseFloat(user.bonus_cup) || 0;

    const items = bet.items || [];
    for (const item of items) {
        if (item.currency === 'CUP') newCup += item.amount;
        else if (item.currency === 'USD') newUsd += item.amount;
        else {
            // si hay otras monedas, convertir a CUP
            const cupVal = await convertToCUP(item.amount, item.currency);
            newCup += cupVal;
        }
    }

    await supabase.from('users').update({ usd: newUsd, cup: newCup, bonus_cup: newBonus, updated_at: new Date() }).eq('telegram_id', uid);
    await supabase.from('bets').delete().eq('id', betId);
    await ctx.answerCbQuery('Jugada cancelada y montos devueltos');
    await ctx.reply('✅ Jugada cancelada y montos reintegrados a tu saldo.');
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
        'Puedes escribir directamente en este chat. Tu mensaje será recibido por nuestro equipo de soporte y te responderemos a la mayor brevedad.\n\n' +
        'También puedes consultar la sección de preguntas frecuentes en nuestra WebApp.',
        Markup.inlineKeyboard([[Markup.button.callback('◀ Volver al inicio', 'main')]])
    );
});

bot.command('webapp', async (ctx) => {
    const webAppButton = Markup.inlineKeyboard([
        Markup.button.webApp('🚀 Abrir WebApp', `${WEBAPP_URL}/app.html`)
    ]);
    await ctx.reply('Haz clic en el botón para acceder a nuestra plataforma web interactiva:', webAppButton);
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
                `Escribe una línea por cada jugada. Puedes poner varios números separados por espacios o comas en la misma línea.\n` +
                `<b>Formato:</b> <code>12 con 5 cup</code>  o  <code>09 10 34*2cup</code>\n` +
                `También puedes usar <b>D</b> (decena) o <b>T</b> (terminal):\n` +
                `- <code>D2 con 5 cup</code> significa TODOS los números que empiezan con 2 (20-29). El costo se multiplica por 10.\n` +
                `- <code>T5 con 1 cup</code> significa TODOS los números que terminan con 5 (05,15,...,95). El costo se multiplica por 10.\n\n` +
                `Ejemplos:\n12 con 1 cup\n09 10 34 con 50 cup\nD2 con 5 cup\nT5*1cup\n34*2 cup\n\n` +
                `💭 <b>Escribe tus jugadas (una o varias líneas):</b>`;
            break;
        case 'corridos':
            instructions = `🏃 <b>CORRIDOS</b> - ${regionMap[lottery]?.emoji || '🎰'} ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada número de 2 DÍGITOS, o varios separados.\n` +
                `<b>Formato:</b> <code>17 con 1 cup</code>  o  <code>32 33*0.5cup</code>\n\n` +
                `Ejemplo:\n17 con 1 cup\n32 33*0.5 cup\n62 con 10 cup\n\n` +
                `💭 <b>Escribe tus jugadas:</b>`;
            break;
        case 'centena':
            instructions = `💯 <b>CENTENA</b> - ${regionMap[lottery]?.emoji || '🎰'} ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada número de 3 DÍGITOS, o varios separados.\n` +
                `<b>Formato:</b> <code>517 con 2 cup</code>  o  <code>019 123*1cup</code>\n\n` +
                `Ejemplo:\n517 con 2 cup\n019 123*1 cup\n123 con 5 cup\n\n` +
                `💭 <b>Escribe tus jugadas:</b>`;
            break;
        case 'parle':
            instructions = `🔒 <b>PARLE</b> - ${regionMap[lottery]?.emoji || '🎰'} ${escapeHTML(lottery)}\n\n` +
                priceInfo +
                `Escribe una línea por cada combinación de dos números de 2 dígitos separados por "x".\n` +
                `<b>Formato:</b> <code>17x32 con 1 cup</code>  o  <code>17x62*2cup</code>\n\n` +
                `Ejemplo:\n17x32 con 1 cup\n17x62*2 cup\n32x62 con 5 cup\n\n` +
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
        `🇨🇺 <b>CUP:</b> ${cup.toFixed(2)} (aprox. ${cupToUsd} USD)\n` +
        `💵 <b>USD:</b> ${usd.toFixed(2)} (aprox. ${usdToCup} CUP)\n` +
        `🎁 <b>Bono (no retirable):</b> ${bonusCup.toFixed(2)} CUP\n\n` +
        `¿Qué deseas hacer?`;
    await safeEdit(ctx, text, myMoneyKbd());
});

bot.action('recharge', async (ctx) => {
    const minDeposit = await getMinDepositUSD();
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

    const rate = await getExchangeRateUSD();
    await safeEdit(ctx,
        `💵 <b>Recargar saldo</b>\n\n` +
        `Elige un método de pago. Luego deberás enviar una captura de pantalla de la transferencia realizada.\n\n` +
        `<b>Mínimo de depósito:</b> ${minDeposit} USD (equivalente a ${(minDeposit * rate).toFixed(2)} CUP)\n\n` +
        `Selecciona el método:`,
        Markup.inlineKeyboard(buttons)
    );
});

bot.action(/dep_(\d+)/, async (ctx) => {
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

    ctx.session.depositMethod = method;
    ctx.session.awaitingDepositPhoto = true;

    let extraInstructions = '';
    if (method.currency === 'USDT' || method.currency === 'TRX') {
        extraInstructions = `\n\n🔐 <b>Importante:</b>\n- Envía el monto exacto en ${method.currency} a la dirección indicada.\n- Asegúrate de usar la red correcta: ${method.confirm.includes('TRC20') ? 'TRC-20' : method.confirm.includes('BEP20') ? 'BEP-20' : method.confirm || 'la red especificada'}.\n- La captura debe mostrar claramente el hash de la transacción (TXID) y el monto.`;
    }

    await safeEdit(ctx,
        `🧾 <b>${escapeHTML(method.name)}</b>\n` +
        `Moneda: ${method.currency}\n` +
        `Datos: <code>${escapeHTML(method.card)}</code>\n` +
        `Confirmar / Red: <code>${escapeHTML(method.confirm)}</code>\n${extraInstructions}\n\n` +
        `📸 <b>Ahora, por favor, envía una captura de pantalla de la transferencia que realizaste.</b>\n` +
        `(Asegúrate de que se vea claramente el monto, la moneda y, para cripto, el hash)`,
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

    const user = ctx.dbUser;
    const minWithdrawUSD = await getMinWithdrawUSD();
    const rate = await getExchangeRateUSD();
    const minWithdrawCUP = (minWithdrawUSD * rate).toFixed(2);

    const totalCUP = parseFloat(user.cup) + parseFloat(user.usd) * rate;
    if (totalCUP < minWithdrawUSD * rate) {
        await ctx.answerCbQuery(`❌ Necesitas al menos ${minWithdrawCUP} CUP (o su equivalente en USD) en tu saldo real para solicitar un retiro.`, { show_alert: true });
        return;
    }

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

bot.action(/wit_(\d+)/, async (ctx) => {
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
    ctx.session.awaitingWithdrawAmount = true;

    const user = ctx.dbUser;
    const minWithdrawUSD = await getMinWithdrawUSD();
    const rate = await getExchangeRateUSD();
    const minWithdrawCUP = (minWithdrawUSD * rate).toFixed(2);

    let saldoEnMoneda = 0;
    let mensajeSaldo = '';
    if (method.currency === 'CUP') {
        saldoEnMoneda = parseFloat(user.cup) || 0;
        mensajeSaldo = `🇨🇺 CUP real: ${saldoEnMoneda.toFixed(2)}`;
    } else if (method.currency === 'USD') {
        saldoEnMoneda = parseFloat(user.usd) || 0;
        mensajeSaldo = `💵 USD real: ${saldoEnMoneda.toFixed(2)}`;
    } else {
        const cupBalance = parseFloat(user.cup) || 0;
        const equivalente = await convertFromCUP(cupBalance, method.currency);
        mensajeSaldo = `💰 Tienes ${cupBalance.toFixed(2)} CUP (equivalente a ${equivalente.toFixed(2)} ${method.currency})`;
    }

    let instruccionesAdicionales = '';
    if (method.currency === 'USDT' || method.currency === 'TRX') {
        instruccionesAdicionales = `\n\n🔐 <b>Para retiros en ${method.currency}:</b>\n` +
            `- Después de confirmar el monto, te pediré por separado:\n` +
            `   • Dirección de wallet\n` +
            `   • Red (ej: TRC-20 para USDT, sugerida: ${method.confirm !== 'ninguno' ? method.confirm : 'la que corresponda'})\n` +
            `- Asegúrate de usar la red correcta para evitar pérdidas.`;
    }

    await safeEdit(ctx,
        `Has elegido <b>${escapeHTML(method.name)}</b> (moneda: ${method.currency}).\n\n` +
        `💳 <b>Instrucciones:</b> ${method.confirm}\n\n` +
        `${mensajeSaldo}\n\n` +
        `⏳ <b>Mínimo de retiro:</b> ${minWithdrawCUP} CUP (equivalente a ${minWithdrawUSD} USD).\n` +
        (method.min_amount ? `📉 Límite mínimo: ${method.min_amount} ${method.currency}\n` : '') +
        (method.max_amount ? `📈 Límite máximo: ${method.max_amount} ${method.currency}\n` : '') +
        `\nPor favor, escribe el <b>monto que deseas retirar</b> en ${method.currency} (ej: <code>500</code> para 500 ${method.currency}).` +
        instruccionesAdicionales,
        null
    );
});

bot.action('transfer', async (ctx) => {
    ctx.session.awaitingTransferTarget = true;
    await safeEdit(ctx,
        '🔄 <b>Transferir saldo a otro usuario</b>\n\n' +
        'Envía el <b>nombre de usuario</b> de Telegram (ej: @usuario) de la persona a la que deseas transferir.\n' +
        'También puedes usar su ID numérico si lo conoces.\n\n' +
        '⚠️ <b>Nota:</b> El bono no es transferible. Puedes transferir CUP o USD.\n\n' +
        'Por favor, ingresa el usuario:',
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
        let text = '📋 <b>Tus últimas 5 jugadas:</b>\n\n';
        bets.forEach((b, i) => {
            const date = moment(b.placed_at).tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
            text += `<b>${i + 1}.</b> 🎰 ${escapeHTML(b.lottery)} - ${escapeHTML(b.bet_type)}\n` +
                `   📝 <code>${escapeHTML(b.raw_text)}</code>\n` +
                `   💰 ${b.cost_cup} CUP / ${b.cost_usd} USD\n` +
                `   🕒 ${date}\n\n`;
        });
        text += '¿Quieres ver más? Puedes consultar el historial completo en la WebApp.';
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
        'Puedes escribirnos directamente en este chat. Nuestro equipo de soporte te responderá a la mayor brevedad.\n\n' +
        'También puedes consultar la sección de preguntas frecuentes en nuestra WebApp.',
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
}

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

    const rates = await getExchangeRates();
    const formattedWinning = formatWinningNumber(winningStr);

    for (const bet of bets || []) {
        const { data: userBefore } = await supabase
            .from('users')
            .select('usd, cup, bonus_cup')
            .eq('telegram_id', bet.user_id)
            .single();

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
                premioTotalUSD += item.usd * multiplicador;
                premioTotalCUP += item.cup * multiplicador;
            }
        }

        if (premioTotalUSD > 0 || premioTotalCUP > 0) {
            let newUsd = parseFloat(userBefore.usd) + premioTotalUSD;
            let newCup = parseFloat(userBefore.cup) + premioTotalCUP;

            await supabase
                .from('users')
                .update({ usd: newUsd, cup: newCup, updated_at: new Date() })
                .eq('telegram_id', bet.user_id);

            const usdEquivalentCup = (premioTotalUSD * rates.rate).toFixed(2);
            const cupEquivalentUsd = (premioTotalCUP / rates.rate).toFixed(2);
            await bot.telegram.sendMessage(bet.user_id,
                `🎉 <b>¡FELICIDADES! Has ganado</b>\n\n` +
                `🔢 Número ganador: <code>${formattedWinning}</code>\n` +
                `🎰 ${regionMap[session.lottery]?.emoji || '🎰'} ${escapeHTML(session.lottery)} - ${escapeHTML(session.time_slot)}\n` +
                `💰 Premio: ${premioTotalCUP.toFixed(2)} CUP / ${premioTotalUSD.toFixed(2)} USD\n` +
                (premioTotalCUP > 0 ? `   (equivale a ${cupEquivalentUsd} USD aprox.)\n` : '') +
                (premioTotalUSD > 0 ? `   (equivale a ${usdEquivalentCup} CUP aprox.)\n` : '') +
                `\n📊 <b>Saldo anterior:</b> ${parseFloat(userBefore.cup).toFixed(2)} CUP / ${parseFloat(userBefore.usd).toFixed(2)} USD\n` +
                `📊 <b>Saldo actual:</b> ${newCup.toFixed(2)} CUP / ${newUsd.toFixed(2)} USD\n\n` +
                `✅ El premio ya fue acreditado a tu saldo. ¡Sigue disfrutando!`,
                { parse_mode: 'HTML' }
            );
        } else {
            await bot.telegram.sendMessage(bet.user_id,
                `🔢 <b>Números ganadores de ${regionMap[session.lottery]?.emoji || '🎰'} ${escapeHTML(session.lottery)} (${session.date} - ${escapeHTML(session.time_slot)})</b>\n\n` +
                `Número: <code>${formattedWinning}</code>\n\n` +
                `😔 Esta vez no has ganado, pero no te desanimes. ¡Sigue intentando y la suerte llegará!\n\n` +
                `🍀 ¡Mucha suerte en la próxima!`,
                { parse_mode: 'HTML' }
            );
        }
    }

    await broadcastToAllUsers(
        `📢 <b>NÚMERO GANADOR PUBLICADO</b>\n\n` +
        `🎰 ${regionMap[session.lottery]?.emoji || '🎰'} <b>${escapeHTML(session.lottery)}</b> - Turno <b>${escapeHTML(session.time_slot)}</b>\n` +
        `📅 Fecha: ${session.date}\n` +
        `🔢 Número: <code>${formattedWinning}</code>\n\n` +
        `💬 Revisa tu historial para ver si has ganado. ¡Mucha suerte en las próximas jugadas!`
    );

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
    const mainButtons = ['🎲 Jugar', '💰 Mi dinero', '📋 Mis jugadas', '👥 Referidos', '❓ Cómo jugar', '🌐 Abrir WebApp', '🔧 Admin'];
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
                `🇨🇺 <b>CUP:</b> ${cup.toFixed(2)} (aprox. ${cupToUsd} USD)\n` +
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
                let text = '📋 <b>Tus últimas 5 jugadas:</b>\n\n';
                bets.forEach((b, i) => {
                    const date = moment(b.placed_at).tz(TIMEZONE).format('DD/MM/YYYY HH:mm');
                    text += `<b>${i + 1}.</b> 🎰 ${escapeHTML(b.lottery)} - ${escapeHTML(b.bet_type)}\n` +
                        `   📝 <code>${escapeHTML(b.raw_text)}</code>\n` +
                        `   💰 ${b.cost_cup} CUP / ${b.cost_usd} USD\n` +
                        `   🕒 ${date}\n\n`;
                });
                text += '¿Quieres ver más? Puedes consultar el historial completo en la WebApp.';
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
                'Puedes escribirnos directamente en este chat. Tu mensaje será recibido por nuestro equipo de soporte y te responderemos a la mayor brevedad.\n\n' +
                'También puedes consultar la sección de preguntas frecuentes en nuestra WebApp.',
                Markup.inlineKeyboard([[Markup.button.callback('◀ Volver al inicio', 'main')]])
            );
            return;
        } else if (text === '🌐 Abrir WebApp') {
            const webAppButton = Markup.inlineKeyboard([
                Markup.button.webApp('🚀 Abrir WebApp', `${WEBAPP_URL}/app.html`)
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
        const buffer = session.depositPhotoBuffer;
        if (!buffer) {
            await ctx.reply('❌ Error: no se encontró la captura. Por favor, comienza el proceso de recarga de nuevo.', getMainKeyboard(ctx));
            delete session.awaitingDepositAmount;
            return;
        }

        const parsed = parseAmountWithCurrency(amountText);
        if (!parsed) {
            await ctx.reply('❌ Formato inválido. Debes escribir el monto seguido de la moneda (ej: <code>500 cup</code> o <code>10 usdt</code>).', getMainKeyboard(ctx));
            return;
        }

        if (parsed.currency !== method.currency) {
            await ctx.reply(`❌ La moneda del monto (${parsed.currency}) no coincide con la del método (${method.currency}). Por favor, envía el monto en ${method.currency}.`, getMainKeyboard(ctx));
            return;
        }

        const minDepositUSD = await getMinDepositUSD();
        const rate = await getExchangeRateUSD();
        let amountUSD = 0;
        switch (parsed.currency) {
            case 'USD': amountUSD = parsed.amount; break;
            case 'CUP': amountUSD = parsed.amount / rate; break;
            case 'USDT': amountUSD = parsed.amount; break;
            case 'TRX': amountUSD = parsed.amount * await getExchangeRateTRX() / rate; break;
            case 'MLC': amountUSD = parsed.amount; break;
        }
        if (amountUSD < minDepositUSD) {
            await ctx.reply(`❌ El monto mínimo de depósito es ${minDepositUSD} USD (equivalente a ${(minDepositUSD * rate).toFixed(2)} CUP). Tu monto equivale a ${amountUSD.toFixed(2)} USD.`, getMainKeyboard(ctx));
            return;
        }

        try {
            const request = await createDepositRequest(uid, method.id, buffer, amountText, parsed.currency);
            for (const adminId of ADMIN_IDS) {
                try {
                    await bot.telegram.sendMessage(adminId,
                        `📥 <b>Nueva solicitud de DEPÓSITO</b>\n` +
                        `👤 Usuario: ${ctx.from.first_name} (${uid})\n` +
                        `🏦 Método: ${escapeHTML(method.name)} (${method.currency})\n` +
                        `💰 Monto: ${amountText}\n` +
                        `📎 <a href="${request.screenshot_url}">Ver captura</a>\n` +
                        `🆔 Solicitud: ${request.id}`,
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
            await ctx.reply(`✅ <b>Solicitud de depósito enviada</b>\nMonto: ${amountText}\n⏳ Tu solicitud está siendo procesada. Te notificaremos cuando se acredite. ¡Gracias por confiar en nosotros!`, { parse_mode: 'HTML' });
        } catch (e) {
            console.error(e);
            await ctx.reply('❌ Error al procesar la solicitud. Por favor, intenta más tarde o contacta a soporte.', getMainKeyboard(ctx));
        }

        delete session.awaitingDepositAmount;
        delete session.depositMethod;
        delete session.depositPhotoBuffer;
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

        const minWithdrawUSD = await getMinWithdrawUSD();
        const rateUSD = await getExchangeRateUSD();
        let amountUSD = 0;
        switch (currency) {
            case 'USD': amountUSD = amount; break;
            case 'CUP': amountUSD = amount / rateUSD; break;
            case 'USDT': amountUSD = amount; break;
            case 'TRX': amountUSD = amount * await getExchangeRateTRX() / rateUSD; break;
            case 'MLC': amountUSD = amount; break;
        }
        if (amountUSD < minWithdrawUSD) {
            await ctx.reply(`❌ El monto mínimo de retiro es ${minWithdrawUSD} USD (equivalente a ${(minWithdrawUSD * rateUSD).toFixed(2)} CUP). Tu monto equivale a ${amountUSD.toFixed(2)} USD.`, getMainKeyboard(ctx));
            return;
        }

        let saldoSuficiente = false;
        if (currency === 'CUP') {
            if ((parseFloat(user.cup) || 0) >= amount) saldoSuficiente = true;
        } else if (currency === 'USD') {
            if ((parseFloat(user.usd) || 0) >= amount) saldoSuficiente = true;
        } else {
            const cupNeeded = await convertToCUP(amount, currency);
            if ((parseFloat(user.cup) || 0) >= cupNeeded) saldoSuficiente = true;
        }

        if (!saldoSuficiente) {
            await ctx.reply(`❌ Saldo insuficiente en ${currency}.`, getMainKeyboard(ctx));
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

        session.withdrawAmount = amount;
        session.withdrawCurrency = currency;
        
        // Dependiendo de la moneda, pedimos los datos de la cuenta
        if (currency === 'USDT' || currency === 'TRX') {
            session.awaitingWithdrawWallet = true; // Nuevo estado para pedir wallet
            delete session.awaitingWithdrawAmount;
            await ctx.reply(
                `✅ Monto aceptado: ${amount} ${currency} (equivale a ${amountUSD.toFixed(2)} USD)\n\n` +
                `Por favor, escribe tu <b>dirección de wallet</b> para recibir el retiro.\n` +
                `(Ejemplo: TXYZ... o 0x... según la red)`,
                { parse_mode: 'HTML' }
            );
        } else {
            session.awaitingWithdrawAccount = true;
            delete session.awaitingWithdrawAmount;
            await ctx.reply(
                `✅ Monto aceptado: ${amount} ${currency} (equivale a ${amountUSD.toFixed(2)} USD)\n\n` +
                `Por favor, escribe los <b>datos de tu cuenta</b> (número de teléfono, tarjeta, etc.) para recibir el retiro.`,
                { parse_mode: 'HTML' }
            );
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
        await ctx.reply(
            `✅ Dirección guardada: ${escapeHTML(wallet)}\n\n` +
            `Ahora, por favor, escribe la <b>red</b> que usarás (ej: TRC-20, BEP-20, etc.).\n` +
            `Si el método sugiere una red (${escapeHTML(session.withdrawMethod.confirm)}), asegúrate de coincidir.`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    // --- Flujo: retiro cripto - red ---
    if (session.awaitingWithdrawNetwork) {
        const network = text.trim();
        if (!network) {
            await ctx.reply('❌ La red no puede estar vacía. Por favor, ingresa la red.', getMainKeyboard(ctx));
            return;
        }
        const wallet = session.withdrawWallet;
        const amount = session.withdrawAmount;
        const currency = session.withdrawCurrency;
        const method = session.withdrawMethod;

        const accountInfo = `Wallet: ${wallet} (Red: ${network})`;

        try {
            const { data: request, error } = await supabase
                .from('withdraw_requests')
                .insert({
                    user_id: uid,
                    method_id: method.id,
                    amount: amount,
                    currency: currency,
                    account_info: accountInfo,
                    status: 'pending'
                })
                .select()
                .single();

            if (error) throw error;

            for (const adminId of ADMIN_IDS) {
                try {
                    await bot.telegram.sendMessage(adminId,
                        `📤 <b>Nueva solicitud de RETIRO (cripto)</b>\n` +
                        `👤 Usuario: ${ctx.from.first_name} (${uid})\n` +
                        `💰 Monto: ${amount} ${currency}\n` +
                        `🏦 Método: ${escapeHTML(method.name)}\n` +
                        `📞 Datos: ${escapeHTML(accountInfo)}\n` +
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
                `📞 Wallet: ${escapeHTML(wallet)}\n` +
                `🔗 Red: ${escapeHTML(network)}\n` +
                `⏳ Procesaremos tu solicitud a la mayor brevedad.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {
            console.error(e);
            await ctx.reply(`❌ Error al crear la solicitud: ${e.message}`, getMainKeyboard(ctx));
        }

        delete session.withdrawWallet;
        delete session.awaitingWithdrawNetwork;
        delete session.withdrawMethod;
        delete session.withdrawAmount;
        delete session.withdrawCurrency;
        return;
    }

    // --- Flujo: retiro no cripto - cuenta ---
    if (session.awaitingWithdrawAccount) {
        const accountInfo = text;
        const amount = session.withdrawAmount;
        const currency = session.withdrawCurrency;
        const method = session.withdrawMethod;

        let saldoSuficiente = false;
        if (currency === 'CUP') {
            if ((parseFloat(user.cup) || 0) >= amount) saldoSuficiente = true;
        } else if (currency === 'USD') {
            if ((parseFloat(user.usd) || 0) >= amount) saldoSuficiente = true;
        } else {
            const cupNeeded = await convertToCUP(amount, currency);
            if ((parseFloat(user.cup) || 0) >= cupNeeded) saldoSuficiente = true;
        }

        if (!saldoSuficiente) {
            await ctx.reply('❌ Saldo insuficiente. La solicitud ha expirado.', getMainKeyboard(ctx));
            delete session.awaitingWithdrawAccount;
            delete session.withdrawMethod;
            delete session.withdrawAmount;
            delete session.withdrawCurrency;
            return;
        }

        const { data: request, error } = await supabase
            .from('withdraw_requests')
            .insert({
                user_id: uid,
                method_id: method.id,
                amount: amount,
                currency: currency,
                account_info: accountInfo,
                status: 'pending'
            })
            .select()
            .single();

        if (error) {
            await ctx.reply(`❌ Error al crear la solicitud: ${error.message}`, getMainKeyboard(ctx));
        } else {
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
        }

        delete session.awaitingWithdrawAccount;
        delete session.withdrawMethod;
        delete session.withdrawAmount;
        delete session.withdrawCurrency;
        return;
    }

    // --- Flujo: transferencia - destino ---
    if (session.awaitingTransferTarget) {
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
            await ctx.reply('❌ Usuario no encontrado. Asegúrate de que el nombre de usuario sea correcto o de que el ID numérico esté registrado.', getMainKeyboard(ctx));
            delete session.awaitingTransferTarget;
            return;
        }
        if (targetUser.telegram_id === uid) {
            await ctx.reply('❌ No puedes transferirte saldo a ti mismo. Elige otro usuario.', getMainKeyboard(ctx));
            delete session.awaitingTransferTarget;
            return;
        }

        session.transferTarget = targetUser.telegram_id;
        session.awaitingTransferAmount = true;
        delete session.awaitingTransferTarget;
        const displayName = targetUser.first_name || targetUser.username || targetUser.telegram_id;
        await ctx.reply(
            `✅ Usuario encontrado: ${escapeHTML(displayName)}\n\n` +
            `Ahora envía el <b>monto y la moneda</b> que deseas transferir (ej: <code>500 cup</code>, <code>10 usd</code>).\n` +
            `💰 Tus saldos: CUP: ${(parseFloat(user.cup) || 0).toFixed(2)}, USD: ${(parseFloat(user.usd) || 0).toFixed(2)}`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    // --- Flujo: transferencia - monto ---
    if (session.awaitingTransferAmount) {
        const parsed = parseAmountWithCurrency(text);
        if (!parsed) {
            await ctx.reply('❌ Formato inválido. Debe ser <code>monto moneda</code> (ej: 500 cup).', getMainKeyboard(ctx));
            return;
        }

        if (!['CUP', 'USD'].includes(parsed.currency)) {
            await ctx.reply('❌ Solo puedes transferir CUP o USD.', getMainKeyboard(ctx));
            return;
        }

        const amount = parsed.amount;
        const currency = parsed.currency;
        const targetId = session.transferTarget;

        let saldoOrigen = 0;
        if (currency === 'CUP') {
            saldoOrigen = parseFloat(user.cup) || 0;
        } else {
            saldoOrigen = parseFloat(user.usd) || 0;
        }
        if (saldoOrigen < amount) {
            await ctx.reply(`❌ No tienes suficiente saldo en ${currency}. Disponible: ${saldoOrigen.toFixed(2)} ${currency}`, getMainKeyboard(ctx));
            return;
        }

        if (currency === 'CUP') {
            await supabase
                .from('users')
                .update({ cup: (parseFloat(user.cup) || 0) - amount, updated_at: new Date() })
                .eq('telegram_id', uid);
        } else {
            await supabase
                .from('users')
                .update({ usd: (parseFloat(user.usd) || 0) - amount, updated_at: new Date() })
                .eq('telegram_id', uid);
        }

        const { data: targetUser } = await supabase
            .from('users')
            .select('cup, usd')
            .eq('telegram_id', targetId)
            .single();

        if (currency === 'CUP') {
            await supabase
                .from('users')
                .update({ cup: (parseFloat(targetUser.cup) || 0) + amount, updated_at: new Date() })
                .eq('telegram_id', targetId);
        } else {
            await supabase
                .from('users')
                .update({ usd: (parseFloat(targetUser.usd) || 0) + amount, updated_at: new Date() })
                .eq('telegram_id', targetId);
        }

        const fromName = user.first_name || user.username || uid;
        const toName = targetUser.first_name || targetUser.username || targetId;

        await ctx.reply(
            `✅ Transferencia realizada con éxito:\n` +
            `💰 Monto: ${amount} ${currency}\n` +
            `👤 De: ${escapeHTML(fromName)}\n` +
            `👤 A: ${escapeHTML(toName)}`,
            { parse_mode: 'HTML' }
        );

        try {
            await bot.telegram.sendMessage(targetId,
                `🔄 <b>Has recibido una transferencia</b>\n\n` +
                `👤 De: ${escapeHTML(fromName)}\n` +
                `💰 Monto: ${amount} ${currency}\n` +
                `📊 Saldo actualizado.`,
                { parse_mode: 'HTML' }
            );
        } catch (e) {}

        delete session.transferTarget;
        delete session.awaitingTransferAmount;
        return;
    }

    // --- Flujo: edición de apuesta (awaitingBetEdit) ---
    if (session.awaitingBetEdit) {
        const betId = session.editingBetId;
        const betType = session.betType;
        const lottery = session.lottery;
        const sessionId = session.sessionId;

        if (!betId) {
            await ctx.reply('❌ No hay jugada seleccionada para editar.', getMainKeyboard(ctx));
            delete session.awaitingBetEdit;
            return;
        }

        const { data: existingBet } = await supabase.from('bets').select('*').eq('id', betId).maybeSingle();
        if (!existingBet) {
            await ctx.reply('❌ Jugada no encontrada.', getMainKeyboard(ctx));
            delete session.awaitingBetEdit;
            delete session.editingBetId;
            return;
        }
        if (parseInt(existingBet.user_id) !== parseInt(ctx.from.id)) {
            await ctx.reply('❌ No autorizado para editar esta jugada.', getMainKeyboard(ctx));
            delete session.awaitingBetEdit;
            delete session.editingBetId;
            return;
        }

        if (existingBet.session_id) {
            const { data: s } = await supabase.from('lottery_sessions').select('status').eq('id', existingBet.session_id).maybeSingle();
            if (!s || s.status !== 'open') {
                await ctx.reply('❌ No se puede editar: sesión cerrada.', getMainKeyboard(ctx));
                delete session.awaitingBetEdit;
                delete session.editingBetId;
                return;
            }
        }

        // El texto a procesar viene en variable text
        const parsed = parseBetMessage(text, betType);
        if (!parsed.ok) {
            await ctx.reply('❌ No se pudo interpretar la jugada. Verifica el formato.', getMainKeyboard(ctx));
            return;
        }

        const totalUSD = parsed.totalUSD;
        const totalCUP = parsed.totalCUP;

        const { data: priceData } = await supabase.from('play_prices').select('min_cup, min_usd, max_cup, max_usd').eq('bet_type', betType).single();
        const minCup = priceData?.min_cup || 0;
        const minUsd = priceData?.min_usd || 0;
        const maxCup = priceData?.max_cup;
        const maxUsd = priceData?.max_usd;

        for (const item of parsed.items) {
            if (item.cup > 0 && item.cup < minCup) { await ctx.reply(`❌ Mínimo CUP: ${minCup}`, getMainKeyboard(ctx)); return; }
            if (item.usd > 0 && item.usd < minUsd) { await ctx.reply(`❌ Mínimo USD: ${minUsd}`, getMainKeyboard(ctx)); return; }
            if (maxCup !== null && item.cup > maxCup) { await ctx.reply(`❌ Máximo CUP: ${maxCup}`, getMainKeyboard(ctx)); return; }
            if (maxUsd !== null && item.usd > maxUsd) { await ctx.reply(`❌ Máximo USD: ${maxUsd}`, getMainKeyboard(ctx)); return; }
        }

        // Reembolsar montos anteriores
        const oldUsd = parseFloat(existingBet.cost_usd) || 0;
        const oldCup = parseFloat(existingBet.cost_cup) || 0;
        const { data: uBefore } = await supabase.from('users').select('usd,cup,bonus_cup').eq('telegram_id', ctx.from.id).single();
        let refundUsd = (parseFloat(uBefore.usd) || 0) + oldUsd;
        let refundCup = (parseFloat(uBefore.cup) || 0) + oldCup;

        await supabase.from('users').update({ usd: refundUsd, cup: refundCup, updated_at: new Date() }).eq('telegram_id', ctx.from.id);

        // Volver a cargar usuario y descontar para nueva apuesta
        const userAfterRefund = await getOrCreateUser(parseInt(ctx.from.id));
        let newUsd = parseFloat(userAfterRefund.usd) || 0;
        let newBonus = parseFloat(userAfterRefund.bonus_cup) || 0;
        let newCup = parseFloat(userAfterRefund.cup) || 0;

        if (totalUSD > 0) {
            const rateUsd = await getExchangeRateUSD();
            const totalDisponible = newUsd + newBonus / rateUsd;
            if (totalDisponible < totalUSD) { await ctx.reply('❌ Saldo USD insuficiente para la edición', getMainKeyboard(ctx)); return; }
            const bonoEnUSD = newBonus / rateUsd;
            const usarBonoUSD = Math.min(bonoEnUSD, totalUSD);
            newBonus -= usarBonoUSD * rateUsd;
            newUsd -= (totalUSD - usarBonoUSD);
        }

        if (totalCUP > 0) {
            const availableCupTotal = newCup + newBonus;
            if (availableCupTotal < totalCUP) { await ctx.reply('❌ Saldo CUP insuficiente para la edición', getMainKeyboard(ctx)); return; }
            if (newCup >= totalCUP) newCup -= totalCUP;
            else {
                const deficit = totalCUP - newCup;
                newBonus = Math.max(0, newBonus - deficit);
                newCup = 0;
            }
        }

        const { data: updatedBet, error: updateError } = await supabase.from('bets').update({ raw_text: text, items: parsed.items, cost_usd: totalUSD, cost_cup: totalCUP, updated_at: new Date() }).eq('id', betId).select().single();
        if (updateError) { console.error('Error actualizando apuesta:', updateError); await ctx.reply('❌ Error al actualizar la jugada', getMainKeyboard(ctx)); return; }

        await supabase.from('users').update({ usd: newUsd, bonus_cup: newBonus, cup: newCup, updated_at: new Date() }).eq('telegram_id', ctx.from.id);

        await ctx.reply('✅ Jugada actualizada correctamente.', getMainKeyboard(ctx));
        delete session.awaitingBetEdit;
        delete session.editingBetId;
        delete session.betType;
        delete session.lottery;
        delete session.sessionId;
        return;
    }

    // --- Flujo: apuesta (awaitingBet) ---
    if (session.awaitingBet) {
        const betType = session.betType;
        const lottery = session.lottery;
        const sessionId = session.sessionId;

        if (!sessionId) {
            await ctx.reply('❌ No se ha seleccionado una sesión activa. Por favor, comienza de nuevo desde "🎲 Jugar".', getMainKeyboard(ctx));
            delete session.awaitingBet;
            return;
        }

        const { data: activeSession } = await supabase
            .from('lottery_sessions')
            .select('*')
            .eq('id', sessionId)
            .eq('status', 'open')
            .maybeSingle();

        if (!activeSession) {
            await ctx.reply('❌ La sesión de juego ha sido cerrada. No se pueden registrar más apuestas para esta sesión.', getMainKeyboard(ctx));
            delete session.awaitingBet;
            return;
        }

        const parsed = parseBetMessage(text, betType);
        if (!parsed.ok) {
            await ctx.reply('❌ No se pudo interpretar tu apuesta. Verifica el formato y vuelve a intentarlo.\n\nSi necesitas ayuda, escribe "❓ Cómo jugar".', getMainKeyboard(ctx));
            return;
        }

        const totalUSD = parsed.totalUSD;
        const totalCUP = parsed.totalCUP;

        if (totalUSD === 0 && totalCUP === 0) {
            await ctx.reply('❌ Debes especificar un monto válido en USD o CUP.', getMainKeyboard(ctx));
            return;
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
            if (item.cup > 0 && item.cup < minCup) {
                await ctx.reply(`❌ El monto mínimo para jugadas en CUP es ${minCup} CUP. Por favor, ajusta tu apuesta.`, getMainKeyboard(ctx));
                return;
            }
            if (item.usd > 0 && item.usd < minUsd) {
                await ctx.reply(`❌ El monto mínimo para jugadas en USD es ${minUsd} USD. Por favor, ajusta tu apuesta.`, getMainKeyboard(ctx));
                return;
            }
            if (maxCup !== null && item.cup > maxCup) {
                await ctx.reply(`❌ Cada jugada en CUP no puede exceder ${maxCup} CUP.`, getMainKeyboard(ctx));
                return;
            }
            if (maxUsd !== null && item.usd > maxUsd) {
                await ctx.reply(`❌ Cada jugada en USD no puede exceder ${maxUsd} USD.`, getMainKeyboard(ctx));
                return;
            }
        }

        let newUsd = parseFloat(user.usd) || 0;
        let newBonus = parseFloat(user.bonus_cup) || 0;
        let newCup = parseFloat(user.cup) || 0;

        if (totalUSD > 0) {
            const rate = await getExchangeRateUSD();
            const totalDisponible = newUsd + newBonus / rate;
            if (totalDisponible < totalUSD) {
                await ctx.reply('❌ Saldo USD (incluyendo bono convertido) insuficiente para realizar esta jugada. Recarga o reduce el monto.', getMainKeyboard(ctx));
                return;
            }
            const usarBonoUSD = Math.min(newBonus / rate, totalUSD);
            newBonus -= usarBonoUSD * rate;
            newUsd -= (totalUSD - usarBonoUSD);
        }

        if (totalCUP > 0) {
            if (newCup < totalCUP) {
                await ctx.reply('❌ Saldo CUP insuficiente. Recarga o reduce el monto.', getMainKeyboard(ctx));
                return;
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
            .eq('telegram_id', uid);

        const { data: bet, error } = await supabase
            .from('bets')
            .insert({
                user_id: uid,
                lottery,
                session_id: sessionId,
                bet_type: betType,
                raw_text: text,
                items: parsed.items,
                cost_usd: totalUSD,
                cost_cup: totalCUP,
                placed_at: new Date()
            })
            .select()
            .single();

        if (error) {
            console.error('Error insertando apuesta:', error);
            await ctx.reply('❌ Error al registrar la apuesta. Por favor, intenta más tarde.', getMainKeyboard(ctx));
            return;
        }

        const rate = await getExchangeRateUSD();
        const usdEquivalentCup = (totalUSD * rate).toFixed(2);
        const cupEquivalentUsd = (totalCUP / rate).toFixed(2);

        await ctx.replyWithHTML(
            `✅ <b>Jugada registrada exitosamente</b>\n` +
            `🎰 ${escapeHTML(lottery)} - ${escapeHTML(betType)}\n` +
            `📝 <code>${escapeHTML(text)}</code>\n` +
            `💰 Costo total: ${totalCUP.toFixed(2)} CUP / ${totalUSD.toFixed(2)} USD\n` +
            (totalCUP > 0 ? `   (equivale a ${cupEquivalentUsd} USD aprox.)\n` : '') +
            (totalUSD > 0 ? `   (equivale a ${usdEquivalentCup} CUP aprox.)\n` : '') +
            `\n🍀 ¡Mucha suerte! Esperamos que seas el próximo ganador.`
        );

        await ctx.reply('¿Qué deseas hacer ahora?', getMainKeyboard(ctx));

        delete session.awaitingBet;
        delete session.betType;
        delete session.lottery;
        delete session.sessionId;
        return;
    }

    // 4. Si no hay ningún flujo activo, se trata como mensaje de soporte
    // Solo si el usuario no es admin (para evitar que los admins se envíen soporte a sí mismos)
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

        session.depositPhotoBuffer = buffer;
        delete session.awaitingDepositPhoto;
        session.awaitingDepositAmount = true;

        await ctx.reply('✅ Captura recibida correctamente. Ahora, por favor, envía el <b>monto transferido</b> con la moneda (ej: <code>500 cup</code> o <code>10 usdt</code>).', { parse_mode: 'HTML' });
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

        const rates = await getExchangeRates();
        // Acreditar en la columna correspondiente según la moneda de la solicitud
        if (parsed.currency === 'CUP') {
            const amountCUP = parsed.amount;
            const { data: user } = await supabase
                .from('users')
                .select('cup')
                .eq('telegram_id', request.user_id)
                .single();
            const newCup = (parseFloat(user.cup) || 0) + amountCUP;
            await supabase
                .from('users')
                .update({ cup: newCup, updated_at: new Date() })
                .eq('telegram_id', request.user_id);
        } else if (parsed.currency === 'USD') {
            // Depositos en USD/USDT acreditan la columna USD (no convertir a CUP)
            const amountUSD = parsed.amount;
            const { data: user } = await supabase
                .from('users')
                .select('usd')
                .eq('telegram_id', request.user_id)
                .single();
            const newUsd = (parseFloat(user.usd) || 0) + amountUSD;
            await supabase
                .from('users')
                .update({ usd: newUsd, updated_at: new Date() })
                .eq('telegram_id', request.user_id);
        } else {
            // Otras monedas se convierten a CUP y se acreditan en CUP
            const amountCUP = await convertToCUP(parsed.amount, parsed.currency);
            const { data: user } = await supabase
                .from('users')
                .select('cup')
                .eq('telegram_id', request.user_id)
                .single();
            const newCup = (parseFloat(user.cup) || 0) + amountCUP;
            await supabase
                .from('users')
                .update({ cup: newCup, updated_at: new Date() })
                .eq('telegram_id', request.user_id);
        }

        await supabase
            .from('deposit_requests')
            .update({ status: 'approved', updated_at: new Date() })
            .eq('id', requestId);

        // Preparar texto del monto acreditado según moneda
        let creditedText = '';
        if (parsed.currency === 'CUP') {
            creditedText = `${parsed.amount.toFixed(2)} CUP`;
        } else if (parsed.currency === 'USD') {
            creditedText = `${parsed.amount.toFixed(2)} USD`;
        } else {
            const amountCUP = await convertToCUP(parsed.amount, parsed.currency);
            creditedText = `${amountCUP.toFixed(2)} CUP (equivalente)`;
        }

        await ctx.telegram.sendMessage(request.user_id,
            `✅ <b>Depósito aprobado</b>\n\n` +
            `💰 Monto depositado: ${request.amount}\n` +
            `💵 Se acreditaron <b>${creditedText}</b> a tu saldo.\n\n` +
            `¡Gracias por confiar en nosotros!`,
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
            await ctx.telegram.sendMessage(request.user_id,
                '❌ <b>Depósito rechazado</b>\nLa solicitud no pudo ser procesada. Por favor, contacta al administrador para más información.',
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
            .select('cup')
            .eq('telegram_id', request.user_id)
            .single();

        const amountCUP = await convertToCUP(request.amount, request.currency);

        if ((parseFloat(user.cup) || 0) < amountCUP) {
            await ctx.reply('❌ El usuario ya no tiene saldo suficiente para este retiro.');
            return;
        }

        await supabase
            .from('users')
            .update({ cup: (parseFloat(user.cup) || 0) - amountCUP, updated_at: new Date() })
            .eq('telegram_id', request.user_id);

        await supabase
            .from('withdraw_requests')
            .update({ status: 'approved', updated_at: new Date() })
            .eq('id', requestId);

        await ctx.telegram.sendMessage(request.user_id,
            `✅ <b>Retiro aprobado</b>\n\n` +
            `💰 Monto retirado: ${request.amount} ${request.currency}\n` +
            `💵 Se debitaron ${amountCUP.toFixed(2)} CUP de tu saldo.\n\n` +
            `Los fondos serán enviados a la cuenta proporcionada en breve.`,
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
