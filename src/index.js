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

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  // === Botón Cambiar Info ===
  if (interaction.customId.startsWith('change_info__')) {
    const [, meta] = interaction.customId.split('__'); // 'meta' viene del botón enviado desde n8n

    try {
      // Mensaje rápido para el usuario
      await interaction.reply({ content: '⚡️ Enviando tu información al Dojo…', ephemeral: true });

      // Enviar datos al webhook de n8n
      const payload = {
        type: 'change_info_clicked',
        action: 'change_info',
        meta_from_custom_id: meta,             // valor que pusiste en el botón desde n8n
        clicked_by_user_id: interaction.user.id,
        clicked_by_user_tag: interaction.user.tag,
        channel_id: interaction.channelId,
        guild_id: interaction.guildId,
        timestamp: new Date().toISOString()
      };

      const response = await fetch(N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(N8N_WEBHOOK_SECRET ? { 'x-webhook-secret': N8N_WEBHOOK_SECRET } : {})
        },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const txt = await response.text();
        console.error('❌ Error enviando a n8n:', txt);
        await interaction.followUp({ content: '❌ Error al contactar con el Dojo.', ephemeral: true });
      } else {
        console.log('✅ Enviado correctamente a n8n');
      }
    } catch (error) {
      console.error('❌ Error general:', error);
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content: '❌ Hubo un error al enviar la info.', ephemeral: true });
      } else {
        await interaction.reply({ content: '❌ Hubo un error al enviar la info.', ephemeral: true });
      }
    }

    return;
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
