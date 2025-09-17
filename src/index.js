// src/index.js
import 'dotenv/config';
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


// Estado en memoria (luego lo moveremos a DB)
const profiles = new Map(); // key: userId → { deseo, referentes, contexto, sesiones, racha, lastMsgId, channelId }


const client = new Client({
intents: [GatewayIntentBits.Guilds],
partials: [Partials.Channel]
});


client.once(Events.ClientReady, () => {
console.log(`✅ Conectado como ${client.user.tag}`);
});


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
    )
  ];
}
