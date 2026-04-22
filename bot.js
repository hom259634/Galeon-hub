const { Telegraf } = require('telegraf');

const bot = new Telegraf('YOUR_BOT_TOKEN');

bot.start((ctx) => {
    ctx.reply('Bot de loterías activo');
});

bot.launch();
console.log('Bot iniciado');
