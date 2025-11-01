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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,   // leer mensajes
    GatewayIntentBits.MessageContent    // leer contenido
  ],
  partials: [Partials.Channel],
});


async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Elimina mensajes de un canal.
 * @param {import('discord.js').Client} clientInstance
 * @param {string} guildId
 * @param {string} channelId
 * @param {object} opts
 *   - strategy: "bulk" | "slow"
 *   - limit: número máximo a borrar (default 1000)
 *   - includePins: si true, borra también pins (por defecto false → los salta)
 *   - beforeId: si se pasa, solo borra mensajes anteriores a ese ID
 */
async function purgeChannel(clientInstance, guildId, channelId, opts = {}) {
  const {
    strategy = 'bulk',
    limit = 1000,
    includePins = false,
    beforeId = undefined
  } = opts;

  const guild = clientInstance.guilds.cache.get(guildId) || await clientInstance.guilds.fetch(guildId);
  const channel = guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId);
  if (!channel?.isTextBased?.()) throw new Error('El canal no es de texto.');

  let deletedCount = 0;
  let skippedPinned = 0;
  let olderThan14Days = 0;
  let errors = [];

  // Helper para filtrar pins
  const filterPins = msgs => includePins ? msgs : msgs.filter(m => !m.pinned);

  if (strategy === 'bulk') {
    // Borra en lotes (solo <14 días)
    let before = beforeId;
    while (deletedCount < limit) {
      const size = Math.min(100, limit - deletedCount);
      const batch = await channel.messages.fetch({ limit: size, ...(before ? { before } : {}) });
      if (!batch.size) break;

      const filtered = filterPins(batch);
      // Discord rechaza los >14 días aquí; bulkDelete ya filtra si pasas true en segundo arg.
      const toDelete = filtered;
      if (!toDelete.size) break;

      // bulkDelete ignora >14 días si pasas true
      const deleted = await channel.bulkDelete(toDelete, true).catch(err => {
        errors.push({ step: 'bulkDelete', message: err.message });
        return null;
      });
      if (!deleted) break;

      deletedCount += deleted.size;
      // Cuenta los que no se borraron por antigüedad (aprox: batch - deleted)
      olderThan14Days += (toDelete.size - deleted.size);

      // Avanza el cursor
      const oldest = toDelete.sort((a, b) => a.createdTimestamp - b.createdTimestamp).first();
      before = oldest?.id;

      // Suaviza rate limit
      await sleep(500);
      if (deleted.size < toDelete.size) {
        // probablemente llegaste a mensajes >14d; sal y deja al caller decidir si hacer slow
        break;
      }
    }
  } else {
    // "slow" → borra uno a uno, sirve para >14 días también
    let before = beforeId;
    while (deletedCount < limit) {
      const size = Math.min(100, limit - deletedCount);
      const batch = await channel.messages.fetch({ limit: size, ...(before ? { before } : {}) });
      if (!batch.size) break;

      const msgs = filterPins(batch)
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp); // de más antiguo a más nuevo

      for (const m of msgs.values()) {
        try {
          await m.delete();
          deletedCount++;
          await sleep(350); // suavizar rate limit
          if (deletedCount >= limit) break;
        } catch (e) {
          // Si fue por pin o permisos, cuenta y sigue
          if (m.pinned && !includePins) skippedPinned++;
          else errors.push({ id: m.id, message: e.message });
        }
      }

      const oldest = batch.sort((a, b) => a.createdTimestamp - b.createdTimestamp).first();
      before = oldest?.id;
      if (msgs.size === 0) break;
    }
  }

  return { ok: true, deletedCount, skippedPinned, olderThan14Days, strategyUsed: strategy, errors };
}

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
const N8N_WEBHOOK_URL = 'https://n8n-n8n.nrna5j.easypanel.host/webhook/update-perfil'; // PRODUCCIÓN
const N8N_WEBHOOK_SECRET = 'opcional123'; // si no usas auth en n8n, pon ''

// Agente HTTPS para tolerar cert self-signed (easypanel/dev)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// ===== Interacciones: botón change_info__... → enviar a n8n =====
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId.startsWith('change_info__')) {
    const [, meta] = interaction.customId.split('__'); // payload desde n8n (userName/ID/etc.)

    try {
      await interaction.deferReply({ ephemeral: true });

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

      const res = await axios.post(N8N_WEBHOOK_URL, payload, {
        headers: {
          'Content-Type': 'application/json',
          ...(N8N_WEBHOOK_SECRET ? { 'x-webhook-secret': N8N_WEBHOOK_SECRET } : {})
        },
        httpsAgent,
        timeout: 15000,
        maxRedirects: 3,
        validateStatus: () => true
      });

      console.log('n8n(change_info) ->', res.status, typeof res.data === 'string' ? res.data : JSON.stringify(res.data));

      if (res.status >= 200 && res.status < 300) {
        await interaction.editReply('⚡️ cargando...');
      } else if (res.status === 401 || res.status === 403) {
        await interaction.editReply('⛔ Secreto del webhook inválido (x-webhook-secret).');
      } else if (res.status === 404) {
        await interaction.editReply('❓ Webhook de n8n no encontrado (URL/path).');
      } else {
        await interaction.editReply(`❌ Error de n8n (${res.status}).`);
      }
    } catch (error) {
      console.error('❌ Error enviando a n8n:', error.message);
      if (interaction.deferred) {
        await interaction.editReply('❌ No se pudo conectar con el Dojo (timeout o certificado).');
      } else {
        await interaction.reply({ content: '❌ Error al contactar con el Dojo.', ephemeral: true });
      }
    }
  }
});

// ===== Mensajes: SOLO en el canal ◉🥷perfil del PROPIO usuario → enviar a n8n =====
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    // Debe ser exactamente el canal de perfil
    if (message.channel?.name !== '◉🥷perfil') return;

    const guild = message.guild;
    const parentId = message.channel?.parentId;
    if (!guild || !parentId) return;

    // Validar que es SU categoría/templo
    const expectedTempleName = `◉🏯templo-de-${message.author.username.toLowerCase()}`;
    const siblingTemple = guild.channels.cache.find(
      c => c.parentId === parentId && c.name === expectedTempleName
    );
    if (!siblingTemple) return;

    const payload = {
      type: 'perfil_message',
      user_id: message.author.id,
      user_tag: message.author.tag,
      content: message.content ?? '',
      attachments: Array.from(message.attachments.values()).map(a => ({
        id: a.id,
        name: a.name,
        url: a.url,
        contentType: a.contentType
      })),
      perfil_channel_id: message.channel.id,
      perfil_category_id: parentId,
      temple_channel_id: siblingTemple.id,
      guild_id: guild.id,
      message_id: message.id,
      timestamp: new Date().toISOString()
    };

    const res = await axios.post(N8N_WEBHOOK_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        ...(N8N_WEBHOOK_SECRET ? { 'x-webhook-secret': N8N_WEBHOOK_SECRET } : {})
      },
      httpsAgent,
      timeout: 15000,
      validateStatus: () => true
    });

    console.log('n8n(perfil_message) ->', res.status, typeof res.data === 'string' ? res.data : JSON.stringify(res.data));
  } catch (err) {
    console.error('❌ Error enviando perfil_message a n8n:', err?.message || err);
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

  // ✅ Purga de mensajes (RUTA SEPARADA, NO ANIDADA)
  app.post('/webhooks/purge-channel', checkSecret, async (req, res) => {
    try {
      if (!clientInstance?.user) {
        return res.status(503).json({ error: 'bot_not_ready' });
      }

      const {
        guild_id,
        channel_id,
        strategy = 'bulk',       // "bulk" (<14d) o "slow" (cualquier antigüedad)
        limit = 1000,
        include_pins = false,
        before_id = undefined,
        fallback_to_slow = true
      } = req.body || {};

      if (!guild_id || !channel_id) {
        return res.status(400).json({ error: 'guild_id y channel_id requeridos' });
      }

      let report = await purgeChannel(clientInstance, guild_id, channel_id, {
        strategy,
        limit: Number(limit),
        includePins: !!include_pins,
        beforeId: before_id
      });

      if (
        strategy === 'bulk' &&
        fallback_to_slow &&
        report.olderThan14Days > 0 &&
        report.deletedCount < Number(limit)
      ) {
        const remaining = Number(limit) - report.deletedCount;
        const slow = await purgeChannel(clientInstance, guild_id, channel_id, {
          strategy: 'slow',
          limit: remaining,
          includePins: !!include_pins
        });
        report = { ...report, followUpSlow: slow };
      }

      return res.json({ ok: true, guild_id, channel_id, report });
    } catch (e) {
      console.error('purge-channel error:', e);
      return res.status(500).json({ error: 'internal_error', detail: e.message });
    }
  });

  // ✅ Session-end (RUTA SEPARADA, COMPLETA)
  app.post('/webhooks/session-end', checkSecret, async (req, res) => {
    try {
      if (!clientInstance?.user) {
        return res.status(503).json({ error: 'bot_not_ready' });
      }

      const {
        guild_id,
        user_id,
        perfil_channel_id,
        sesiones_hechas,
        racha,
        deseo,
        referentes,
        contexto
      } = req.body || {};

      if (!guild_id || !user_id || !perfil_channel_id) {
        return res.status(400).json({ error: 'guild_id, user_id y perfil_channel_id requeridos' });
      }

      const guild =
        clientInstance.guilds.cache.get(guild_id) ||
        (await clientInstance.guilds.fetch(guild_id));
      const member = await guild.members.fetch(user_id);
      const user = member.user;

      const channel =
        guild.channels.cache.get(perfil_channel_id) ||
        (await guild.channels.fetch(perfil_channel_id));

      const prev = profiles.get(user.id) || {
        deseo: '',
        referentes: '',
        contexto: '',
        sesiones: 0,
        racha: 0,
        lastMsgId: null,
        channelId: perfil_channel_id,
      };

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

  const PORT = process.env.PORT || process.env.WEBHOOK_PORT || 3000;
  app.listen(PORT, () => console.log(`🌐 Web server listening on :${PORT}`));
}


// ===== Inicia el bot =====
client.login(process.env.DISCORD_TOKEN).catch(err => {
  console.error('❌ Discord login failed:', err);
});
