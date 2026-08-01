'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   RedasP — discord-bot.js  v4.0  (apenas /menu com painel público)
   Compatível com o server.js v3.0 (sem proxy, captcha fake)
═══════════════════════════════════════════════════════════════════════════ */

const {
  Client, GatewayIntentBits, REST, Routes,
  SlashCommandBuilder, EmbedBuilder, ActivityType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} = require('discord.js');
const http = require('http');
const fs   = require('fs');
const path = require('path');

/* ─── Config ────────────────────────────────────────────────────────────── */
const CFG_PATH = path.join(__dirname, 'config.json');
let CFG;
try {
  CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
} catch (e) {
  console.error('[BOT] ERRO: config.json não encontrado:', e.message);
  process.exit(1);
}

const BOT_TOKEN  = CFG.owner?.discord_token || process.env.DISCORD_BOT_TOKEN || '';
const SERVER_URL = `http://localhost:${(CFG.server?.port || 3000) + 1}`;

if (!BOT_TOKEN) {
  console.error('[BOT] discord_token ausente no config.json / DISCORD_BOT_TOKEN env');
  process.exit(1);
}

/* ─── Sessões por usuário ─────────────────────────────────────────────── */
const userSessions = new Map(); // userId → { sessionId, nick, ra }

/* ─── HTTP helper ──────────────────────────────────────────────────────── */
function apiPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost',
      port: (CFG.server?.port || 3000) + 1,
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch (_) { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

/* ─── Comandos ────────────────────────────────────────────────────────── */
const commands = [
  new SlashCommandBuilder()
    .setName('menu')
    .setDescription('Abre o painel público de login e redações'),
].map(c => c.toJSON());

/* ─── Client ────────────────────────────────────────────────────────────── */
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`[BOT] Online como ${client.user.tag}`);
  client.user.setActivity('Sala do Futuro', { type: ActivityType.Watching });

  try {
    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('[BOT] Comando /menu registrado');
  } catch (e) {
    console.error('[BOT] Erro ao registrar comando:', e.message);
  }
});

/* ─── Função para criar o embed do menu ──────────────────────────────── */
function buildMenuEmbed() {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎓 RedasP — Automação de Redações')
    .setDescription(
      'Clique no botão abaixo para fazer login com suas credenciais da Sala do Futuro.\n' +
      'Após o login, você poderá usar os comandos `/redacoes`, `/fazer`, `/status` e `/sair`.\n\n' +
      '🔒 **Seus dados são usados apenas para autenticar na plataforma.**'
    )
    .addFields(
      { name: '📋 Comandos disponíveis', value: '`/redacoes` – listar pendentes\n`/fazer` – gerar e enviar\n`/status` – ver sistema\n`/sair` – encerrar sessão' }
    )
    .setFooter({ text: 'RedasP v4.0 • Painel público' })
    .setTimestamp();
}

/* ─── Componentes do menu (botão) ────────────────────────────────────── */
function getMenuButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('login_modal')
      .setLabel('🔑 Fazer Login')
      .setStyle(ButtonStyle.Primary)
  );
}

/* ─── Interações ────────────────────────────────────────────────────────── */
client.on('interactionCreate', async interaction => {
  // ─── Slash Command: /menu ────────────────────────────────────────────
  if (interaction.isChatInputCommand() && interaction.commandName === 'menu') {
    // Envia o painel público (NÃO ephemeral)
    await interaction.reply({
      embeds: [buildMenuEmbed()],
      components: [getMenuButtons()],
      ephemeral: false, // visível para todos
    });
    return;
  }

  // ─── Botão: login_modal ──────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === 'login_modal') {
    const modal = new ModalBuilder()
      .setCustomId('login_modal_submit')
      .setTitle('🔑 Login na Sala do Futuro');

    const raInput = new TextInputBuilder()
      .setCustomId('ra')
      .setLabel('RA (ex: 0001234567890SP)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('Digite seu RA');

    const senhaInput = new TextInputBuilder()
      .setCustomId('senha')
      .setLabel('Senha')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setPlaceholder('Digite sua senha');

    modal.addComponents(
      new ActionRowBuilder().addComponents(raInput),
      new ActionRowBuilder().addComponents(senhaInput)
    );

    await interaction.showModal(modal);
    return;
  }

  // ─── Modal: submit do login ──────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'login_modal_submit') {
    await interaction.deferReply({ ephemeral: true });

    const ra = interaction.fields.getTextInputValue('ra').trim();
    const senha = interaction.fields.getTextInputValue('senha').trim();

    try {
      const { status, body } = await apiPost('/api/login', { ra, senha });
      if (status !== 200 || !body.sessionId) {
        return interaction.editReply(`❌ **Falha no login:** ${body.error || 'Erro desconhecido'}`);
      }

      // Salva sessão do usuário
      userSessions.set(interaction.user.id, {
        sessionId: body.sessionId,
        nick: body.nick || ra,
        ra: body.ra,
      });

      // Busca total de redações (para exibir)
      const essaysRes = await apiPost('/api/essays', { sessionId: body.sessionId });
      const total = essaysRes.body?.tasks?.length || 0;

      const embed = new EmbedBuilder()
        .setColor(0x4caf50)
        .setTitle('✅ Login realizado com sucesso')
        .addFields(
          { name: 'Aluno', value: body.nick || ra, inline: true },
          { name: 'RA', value: body.ra, inline: true },
          { name: 'Redações pendentes', value: String(total), inline: true }
        )
        .setFooter({ text: 'Use /menu para ver o painel novamente' });

      await interaction.editReply({ embeds: [embed] });
    } catch (e) {
      await interaction.editReply(`❌ **Erro de conexão:** ${e.message}\nO servidor RedasP está rodando?`);
    }
    return;
  }
});

/* ─── Startup ───────────────────────────────────────────────────────────── */
client.login(BOT_TOKEN).catch(e => {
  console.error('[BOT] Falha ao conectar ao Discord:', e.message);
  process.exit(1);
});

process.on('SIGTERM', () => { client.destroy(); process.exit(0); });
process.on('SIGINT',  () => { client.destroy(); process.exit(0); });