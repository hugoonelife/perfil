// src/register-commands.js
import 'dotenv/config';
import { REST, Routes, SlashCommandBuilder } from 'discord.js';


const commands = [
new SlashCommandBuilder()
.setName('perfil_publicar')
.setDescription('Publica/actualiza tu embed de perfil en este canal')
.addStringOption(o => o.setName('deseo').setDescription('Tu deseo').setRequired(false))
.addStringOption(o => o.setName('referentes').setDescription('Lista o texto de referentes').setRequired(false))
.addStringOption(o => o.setName('contexto').setDescription('Contexto rápido').setRequired(false))
.toJSON()
];


const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);


try {
await rest.put(
Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
{ body: commands }
);
console.log('✅ Comandos registrados en el guild.');
} catch (err) {
console.error('❌ Error registrando comandos:', err);
}