// src/index.js
import 'dotenv/config';
import express from 'express';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  ModalBuilder,
  Partials,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';

// ===== Config servidor HTTP =====
const PORT = process.env.PORT || process.env.WEBHOOK_PORT || 3000;

// ===== Estado en memoria (cámbialo a DB más adelante) =====
// key: userId → { deseo, referentes, contexto, sesiones, racha, lastMsgId, channelId }
const profiles = new Map();

// ===== Discord client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

client.once(Events.ClientReady, () => {
  console.log(`✅ Conectado como ${client.user.tag}`);
  startWebhookServer(client); // inicia Express
});

// ===== Embed y botones =====
function buildEmbed(user, data) {
  return new EmbedBuilder()
    .setTitle(`Perfil de ${user.username}`)
    .setColor(0x5865F2)
    .addFields(
      { name: 'Deseo', value: data.deseo || '—', inline: false },
      { name: 'Referentes', value: data.referentes || '—', inline: false },
      { name: 'Contexto', value: data.contexto || '—', inline: false },
      { name: 'Sesiones hechas', value: String(data.sesiones ?? 0), inline: true },
      { name: 'Racha', value: String(data.racha ?? 0), inline: true }
    )
    .setFooter({ text: `Última actualización: ${new Date().toLocaleString()}` });
}

function buildComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('perfil:cambiar_deseo')
        .setLabel('Cambiar deseo')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('perfil:editar_referentes')
        .setLabel('Editar referentes')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('perfil:editar_contexto')
        .setLabel('Editar contexto')
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

// ===== Envío/actualización del embed =====
async function publishOrRefreshProfile(channel, user, patch = {}) {
  const prev = profiles.get(user.id) || {
    deseo: '',
    referentes: '',
    contexto: '',
    sesiones: 0,
    racha: 0,
    lastMsgId: null,
    channelId: channel.id,
  };

  const data = { ...prev, ...patch, channelId: channel.id };

  // Borra el embed anterior si existe
  if (data.lastMsgId) {
    try {
      const old = await channel.messages.fetch(data.lastMsgId);
      if (old?.deletable) await old.delete();
    } catch {
      // si no existe/permiso, continuamos
    }
  }

  // Publica nuevo embed con botones
  const embed = buildEmbed(user, data);
  const components = buildComponents();
  const sent = await channel.send({ embeds: [embed], components });

  // Guarda referencia
  data.lastMsgId = sent.id;
  profiles.set(user.id, data);
}

// ===== Servidor Express: solo /webhooks/session-end =====
function startWebhookServer(client) {
  const app = express();
  app.use(express.json());

  // Auth simple por secreto
  function checkSecret(req, res, next) {
    const secret = req.headers['x-webhook-secret'];
    if (process.env.WEBHOOK_SECRET && secret !== process.env.WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    next();
  }

  // Healthcheck
  app.get('/health', (_req, res) => res.json({ ok: true }));

  // n8n manda canal + valores → el bot solo refresca el embed
  app.post('/webhooks/session-end', checkSecret, async (req, res) => {
    try {
      const {
        guild_id,
        user_id,
        perfil_channel_id, // canal exacto donde debe ir el perfil
        sesiones_hechas,   // número (n8n ya lo calcula)
        racha,             // número (n8n ya lo calcula)
        deseo,             // opcional: solo en onboarding
        referentes,        // opcional
        contexto           // opcional
      } = req.body || {};

      if (!guild_id || !user_id || !perfil_channel_id) {
        return res
          .status(400)
          .json({ error: 'guild_id, user_id y perfil_channel_id requeridos' });
      }

      const guild =
        client.guilds.cache.get(guild_id) || (await client.guilds.fetch(guild_id));
      const member = await guild.members.fetch(user_id);
      const user = member.user;

      // Canal de perfil que viene desde n8n
      const channel =
        guild.channels.cache.get(perfil_channel_id) ||
        (await guild.channels.fetch(perfil_channel_id));

      // Estado previo (por si no pasan todos los campos cada vez)
      const prev = profiles.get(user.id) || {
        deseo: '',
        referentes: '',
        contexto: '',
        sesiones: 0,
        racha: 0,
        lastMsgId: null,
        channelId: perfil_channel_id,
      };

      // Aplica solo lo que llega; si no llega, conserva
      const patch = {
        deseo: typeof deseo === 'string' ? deseo : prev.deseo,
        referentes: typeof referentes === 'string' ? referentes : prev.referentes,
        contexto: typeof contexto === 'string' ? contexto : prev.contexto,
        sesiones: Number.isFinite(sesiones_hechas) ? sesiones_hechas : prev.sesiones,
        racha: Number.isFinite(racha) ? racha : prev.racha,
        channelId: perfil_channel_id,
      };

      await publishOrRefreshProfile(channel, user, patch);

      return res.json({ ok: true, channel_id: channel.id });
    } catch (e) {
      console.error('session-end error:', e);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  app.listen(PORT, () => console.log(`🌐 Web server listening on :${PORT}`));
}

// ===== Inicia el bot =====
client.login(process.env.DISCORD_TOKEN);
