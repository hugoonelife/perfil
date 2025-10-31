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

import axios from 'axios';
import https from 'https';


// ===== Config servidor HTTP =====
const PORT = process.env.PORT || process.env.WEBHOOK_PORT || 3000;

// ===== Estado en memoria (cámbialo a DB más adelante) =====
// key: userId → { deseo, referentes, contexto, sesiones, racha, lastMsgId, channelId }
const profiles = new Map();

// ===== Discord client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], // <- añadido GuildMembers
  partials: [Partials.Channel],
});

// ===== Arranca Express UNA sola vez (antes del login) =====
startWebhookServer(client);

client.once(Events.ClientReady, () => {
  console.log(`✅ Conectado como ${client.user.tag}`);
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

// ===== Configuración directa de n8n =====
const N8N_WEBHOOK_URL = 'https://n8n-n8n.nrna5j.easypanel.host/webhook/update-perfil'; // cambia por tu webhook real
const N8N_WEBHOOK_SECRET = 'opcional123'; // cambia por tu webhook real

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith('change_info__')) {
    const [, meta] = interaction.customId.split('__'); // meta = dato que mandaste desde n8n (por ej. userName)

    try {
      // Paso 1: responder rápido para que Discord no marque "Interacción fallida"
      await interaction.deferReply({ ephemeral: true });

      // Paso 2: construir payload
      const payload = {
        type: 'change_info_clicked',
        action: 'change_info',
        meta_from_custom_id: meta,
        clicked_by_user_id: interaction.user.id,
        clicked_by_user_tag: interaction.user.tag,
        channel_id: interaction.channelId,
        guild_id: interaction.guildId,
        timestamp: new Date().toISOString(),
      };

      // Paso 3: enviar a n8n con axios + agente https
      const res = await axios.post(N8N_WEBHOOK_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          ...(N8N_WEBHOOK_SECRET ? { 'x-webhook-secret': N8N_WEBHOOK_SECRET } : {}),
        },
        httpsAgent, // esto evita errores de certificado
        timeout: 10000,
      });

      // Paso 4: mensaje final en Discord
      if (res.status >= 200 && res.status < 300) {
        await interaction.editReply('⚡️ Información enviada al Dojo correctamente.');
      } else {
        await interaction.editReply(`❌ Error al contactar con n8n (${res.status}).`);
      }
    } catch (error) {
      console.error('❌ Error enviando a n8n:', error.message);

      // Si el error fue de red o timeout
      if (interaction.deferred) {
        await interaction.editReply('❌ No se pudo conectar con el Dojo (timeout o certificado).');
      } else {
        await interaction.reply({ content: '❌ Error al contactar con el Dojo.', ephemeral: true });
      }
    }
  }
});




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
function startWebhookServer(clientInstance) {
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
  app.get('/health', (_req, res) => {
    res.json({ ok: true, botReady: !!clientInstance?.user });
  });

  // n8n manda canal + valores → el bot solo refresca el embed
  app.post('/webhooks/session-end', checkSecret, async (req, res) => {
    try {
      if (!clientInstance?.user) {
        // si el bot aún no está listo, devolvemos 503 controlado
        return res.status(503).json({ error: 'bot_not_ready' });
      }

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
        clientInstance.guilds.cache.get(guild_id) ||
        (await clientInstance.guilds.fetch(guild_id));
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
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Discord login failed:', err);
});
