import { Client, GatewayIntentBits, Partials } from 'discord.js';
import dotenv from 'dotenv';
import http from 'node:http';

dotenv.config();

function env(name) {
  return process.env[name]?.trim() ?? '';
}

function loadConfig() {
  const missing = [];
  const need = (n) => {
    const v = env(n);
    if (!v) missing.push(n);
    return v;
  };

  const channelId = need('CHANNEL_ID');
  const roleId = need('ROLE_ID');
  const successMessage = need('SUCCESS_MESSAGE');
  const failureMessage = need('FAILURE_MESSAGE');

  if (missing.length) {
    console.error(
      'Variables d’environnement manquantes (définis-les dans Railway → Variables) :\n  ' +
        missing.join(', ')
    );
    process.exit(1);
  }

  const delay = Number(env('SUCCESS_REPLY_DELAY_MS'));
  const successReplyDelayMs = Number.isFinite(delay) && delay >= 0 ? delay : 3000;
  const failDelay = Number(env('FAILURE_REPLY_DELAY_MS'));
  const failureReplyDelayMs = Number.isFinite(failDelay) && failDelay >= 0 ? failDelay : 2000;
  const roleErrorMessage = env('ROLE_ERROR_MESSAGE') || undefined;

  return {
    channelId: String(channelId),
    roleId: String(roleId),
    successMessage,
    failureMessage,
    successReplyDelayMs,
    failureReplyDelayMs,
    roleErrorMessage,
  };
}

const token = env('DISCORD_TOKEN');
if (!token) {
  console.error('Variable DISCORD_TOKEN manquante (Railway → Variables).');
  process.exit(1);
}

const config = loadConfig();

function isImageAttachment(attachment) {
  const ct = attachment.contentType;
  if (ct && ct.startsWith('image/')) return true;
  const name = attachment.name || '';
  return /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel, Partials.Message],
});

let healthServer = null;
const portRaw = process.env.PORT;
if (portRaw) {
  const port = Number(portRaw);
  if (Number.isFinite(port) && port > 0) {
    healthServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
    });
    healthServer.listen(port, '0.0.0.0', () => {
      console.log(`Healthcheck HTTP sur 0.0.0.0:${port}`);
    });
  }
} else {
  console.warn('PORT non défini : healthcheck HTTP désactivé (normal hors Railway).');
}

client.once('ready', () => {
  console.log(`Connecté en tant que ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;
  if (message.channelId !== config.channelId) return;

  const images = [...message.attachments.values()].filter(isImageAttachment);
  const totalAttachments = message.attachments.size;

  if (images.length >= 5) {
    const guildId = message.guildId;
    const userId = message.author.id;
    const roleId = config.roleId;

    const delay = config.successReplyDelayMs;
    setTimeout(async () => {
      const roleErrorHint =
        config.roleErrorMessage ??
        'Je n’ai pas pu t’attribuer le rôle. Un admin doit placer **mon rôle** plus haut que le rôle VIP dans Paramètres du serveur → Rôles, et m’accorder la permission **Gérer les rôles**.';

      try {
        const guild = await client.guilds.fetch(guildId);
        const member = await guild.members.fetch({ user: userId, force: true });
        const role = await guild.roles.fetch(roleId).catch(() => null);

        if (!role) {
          console.error(`Rôle introuvable (roleId=${roleId}). Vérifie ROLE_ID sur Railway.`);
          await message.reply({ content: roleErrorHint });
          return;
        }

        const already = member.roles.cache.has(roleId);
        if (!already) {
          await member.roles.add(role, '5 photos validées dans le salon configuré');
        }

        await message.reply({ content: config.successMessage });
      } catch (e) {
        const msg = e?.message ?? e;
        console.error('Attribution du rôle ou réponse :', e?.code ?? '', msg);
        try {
          await message.reply({ content: roleErrorHint });
        } catch (replyErr) {
          console.error('Impossible d’envoyer le message d’erreur :', replyErr);
        }
      }
    }, delay);
    return;
  }

  if (totalAttachments > 0 && images.length < 5) {
    const failDelay = config.failureReplyDelayMs;
    setTimeout(async () => {
      try {
        await message.reply({ content: config.failureMessage });
      } catch (e) {
        console.error('Impossible d’envoyer le message d’échec :', e);
      }
    }, failDelay);
  }
});

async function shutdown(signal) {
  console.log(`Signal ${signal}, arrêt propre…`);
  try {
    await client.destroy();
  } catch {
    /* déjà déconnecté */
  }
  if (healthServer) {
    await new Promise((resolve) => {
      healthServer.close(() => resolve());
    });
  }
  process.exit(0);
}

process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));

client.login(token);
