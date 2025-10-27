//MERCADOPAGO_ACCESS_TOKEN=APP_USR-7855046346221457-091818-dab4718d88b0eb7d65c9e998a6ed4a63-1099777240
//url: 
const {
    Client,
    GatewayIntentBits,
    Partials,
    ChannelType,
    EmbedBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    PermissionsBitField,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags,
    AttachmentBuilder,
} = require('discord.js');
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
require('dotenv').config();
const PagSeguro = require('pagseguro-nodejs');
const axios = require('axios');
const QRCode = require('qrcode');
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
});
// --- Cliente do Express (da antiga API) ---
const app = express();
app.use(express.json());

// --- Cliente do Mercado Pago (da antiga API) ---
// ATENÇÃO: Renomeado para 'mpClient' para não conflitar com o 'client' do Discord
const pagbankClient = new PagSeguro({
    email: process.env.PAGBANK_EMAIL,
    token: process.env.PAGBANK_TOKEN,
    // O SDK espera 'sandbox' ou 'production', então garantimos o formato correto
    env: process.env.PAGBANK_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'production',
});

// IDs do servidor
const GUILD_ID = '1417557260095328438'; 
const CANAL_PAINEL_ID = '1417583842256224337';
const CATEGORIA_PAGAMENTOS_ID = '1417568378637254857';
const REGISTRADO_ROLE_ID = '1417567838192799945';
const VIP_ROLE_ID = '1417567360545460325';
const AGUARDANDO_PAGAMENTO_ROLE_ID = '1417567895868932199';
const CANAL_REGISTRO_ID = '1417583803194675323';
const LOG_PAGAMENTOS_ID = '1417557261189910580';
const LOGS_BOTS_ID = '1417566269263183952';
const NOTIFICACOES_ID = '1417566342823018566';
const CANAL_WHATSAPP_ID = '1417566470333796402';
const EXCLUIDOS_ID = '1417566387399819304';
const LOG_COUPONS_ID = '1417566495776575559';
const CATEGORIA_EXPIRATIONS_ID = '1417568449965592777';

// Conexão com MongoDB
const mongoUri = process.env.MONGO_URI;
// SUBSTITUA SEU BLOCO 'mongoClient' POR ESTE
// SUBSTITUA SEU BLOCO 'mongoClient' POR ESTE
const mongoClient = new MongoClient(mongoUri, {
    tls: true,
    tlsInsecure: process.env.MONGO_TLS_INSECURE === 'true',
    serverSelectionTimeoutMS: 60000, // Esta opção é válida e importante
    socketTimeoutMS: 60000,          // Esta opção é válida e importante
    connectTimeoutMS: 30000,
    heartbeatFrequencyMS: 30000,     // Esta opção é válida e importante
    // As opções 'keepAlive' e 'keepAliveInitialDelay' foram removidas.
});

// ADICIONE ESTE BLOCO LOGO APÓS A CRIAÇÃO DO mongoClient
mongoClient.on('close', () => {
    console.warn('[MongoDB] A conexão com o MongoDB foi fechada. Tentando reconectar em 15 segundos...');
    setTimeout(() => {
        console.log('[MongoDB] Tentando reinicializar a conexão, coleções e Change Streams...');
        // Chama a função que já existe para reconectar e reativar tudo
        initializeCollections().catch(err => {
            console.error('[MongoDB] Falha crítica na tentativa de reinicialização automática:', err);
        });
    }, 15000); // Tenta reconectar após 15 segundos
});

let db;

// Mapa para armazenar a relação _id -> userId
const userIdCache = new Map();

// ADICIONE ESTA LINHA
const activePaymentChannels = new Map(); // Mapa para UserId -> ChannelId

// Mapa para armazenar o intervalo global de verificação
const expirationCheckInterval = new Map();

// Inicialização das coleções
let registeredUsers, userBalances, paymentValues, activePixChannels, expirationDates, notificationSent, paymentHistory, couponUsage;

async function connectDB() {
    try {
        await mongoClient.connect();
        console.log('Conectado ao MongoDB');
        db = mongoClient.db('moneybet');
        return db;
    } catch (err) {
        console.error('Erro ao conectar ao MongoDB:', err);
        throw err;
    }
}

async function initializeCollections() {
    try {
        const db = await connectDB();
        registeredUsers = db.collection('registeredUsers');
        userBalances = db.collection('userBalances');
        paymentValues = db.collection('paymentValues');
        activePixChannels = db.collection('activePixChannels');
        expirationDates = db.collection('expirationDates');
        notificationSent = db.collection('notificationSent');
        paymentHistory = db.collection('paymentHistory');
        couponUsage = db.collection('couponUsage');

        console.log('Coleções inicializadas com sucesso');
        await setupChangeStream();
        await setupRegisteredUsersChangeStream();
    } catch (err) {
        console.error('Erro ao inicializar coleções:', err);
        setTimeout(initializeCollections, 5000); // Retry após 5 segundos
    }
}

async function setupChangeStream() {
    if (!expirationDates) {
        console.error('Coleção expirationDates não inicializada. Aguardando reinicialização...');
        return setTimeout(setupChangeStream, 5000);
    }

    try {
        const changeStream = expirationDates.watch([], { fullDocument: 'updateLookup' });
        console.log('Change Stream iniciado para expirationDates');

        changeStream.on('change', async (change) => {
            const documentKey = change.documentKey;
            if (!documentKey || !documentKey._id) {
                console.warn('Documento sem _id detectado no change stream de expirationDates:', change);
                return;
            }

            const docId = documentKey._id.toString();
            let userId;

            if (change.fullDocument && change.fullDocument.userId) {
                userId = change.fullDocument.userId.toString();
                userIdCache.set(docId, userId);
            } else if (documentKey.userId) {
                userId = documentKey.userId.toString();
                userIdCache.set(docId, userId);
            } else {
                try {
                    const registeredDoc = await registeredUsers.findOne(
                        { 'paymentHistory.expirationId': documentKey._id },
                        { projection: { userId: 1 } }
                    );
                    if (registeredDoc && registeredDoc.userId) {
                        userId = registeredDoc.userId.toString();
                        userIdCache.set(docId, userId);
                    }
                } catch (err) {
                    console.error(`Erro ao buscar userId para _id ${docId} em expirationDates:`, err);
                    return;
                }
            }

            if (!userId) {
                console.warn(`Não foi possível determinar o userId para _id ${docId} em expirationDates. Ação abortada.`);
                return;
            }

            const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
            if (!guild) return;

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) return;
            
            const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');

            if (change.operationType === 'delete') {
                // (A lógica de 'delete' permanece a mesma)
                console.log(`Assinatura cancelada para userId ${userId}`);
                try {
                    await member.roles.remove(VIP_ROLE_ID);
                    await member.roles.add(AGUARDANDO_PAGAMENTO_ROLE_ID);
                    await notificationSent.deleteMany({ userId });

                    const excluidosChannel = await guild.channels.fetch(EXCLUIDOS_ID);
                    const embedExcluidos = new EmbedBuilder()
                        .setTitle('🚫 Assinatura Cancelada')
                        .setDescription(`A assinatura de <@${userId}> foi cancelada via painel.`)
                        .addFields(
                            { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                            { name: '🆔 ID', value: userId, inline: true },
                            { name: '🕒 Horário', value: horario, inline: true },
                        )
                        .setColor('#FF0000').setTimestamp();
                    await excluidosChannel.send({ embeds: [embedExcluidos] });
                } catch (err) {
                    console.error(`Erro ao processar cancelamento para ${userId}:`, err);
                }

            } else if (change.operationType === 'insert' || change.operationType === 'update') {
                const fullDocument = change.fullDocument;
                if (!fullDocument || !fullDocument.expirationDate) return;

                const expirationDate = new Date(fullDocument.expirationDate);
                const now = new Date();

                if (expirationDate > now) {
                    // SE A DATA FOR NO FUTURO, APENAS ATUALIZA OS CARGOS
                    console.log(`[Change Stream] Assinatura de ${userId} está ativa. Garantindo cargos...`);
                    await member.roles.add(VIP_ROLE_ID).catch(err => console.error(err));
                    await member.roles.remove(AGUARDANDO_PAGAMENTO_ROLE_ID).catch(err => console.error(err));
                } else {
                    // --- CORREÇÃO APLICADA AQUI ---
                    // SE A DATA FOR NO PASSADO, CHAMA A LÓGICA COMPLETA DE EXPIRAÇÃO
                    console.log(`[Change Stream] Alteração manual para data expirada detectada para ${userId}. Iniciando verificação completa...`);
                    await checkExpirationNow(userId, expirationDate);
                }
            }
        });

        changeStream.on('error', (err) => {
            console.error('Erro no Change Stream:', err);
            setTimeout(setupChangeStream, 10000);
        });
    } catch (err) {
        console.error('Erro ao configurar Change Stream:', err);
        setTimeout(setupChangeStream, 10000);
    }
}

async function setupRegisteredUsersChangeStream() {
    if (!registeredUsers) {
        console.error('Coleção registeredUsers não inicializada. Aguardando reinicialização...');
        return setTimeout(setupRegisteredUsersChangeStream, 5000);
    }

    try {
        const changeStream = registeredUsers.watch([], { fullDocument: 'updateLookup' });
        console.log('Change Stream iniciado para registeredUsers');

        changeStream.on('change', async (change) => {
            const documentKey = change.documentKey;
            if (!documentKey || !documentKey._id) {
                console.warn('Documento sem _id detectado no change stream de registeredUsers:', change);
                return;
            }

            const docId = documentKey._id.toString();
            let userId;

            // Tentar obter userId diretamente do change stream
            if (change.fullDocument && change.fullDocument.userId) {
                userId = change.fullDocument.userId.toString();
                console.log(`userId extraído do fullDocument para _id ${docId}: ${userId}`);
                userIdCache.set(docId, userId);
            } else if (documentKey.userId) {
                userId = documentKey.userId.toString();
                console.log(`userId extraído do documentKey para _id ${docId}: ${userId}`);
                userIdCache.set(docId, userId);
            } else {
                // Para operações de delete, buscar userId no documento antes da exclusão
                try {
                    const doc = await registeredUsers.findOne(
                        { _id: new ObjectId(documentKey._id) },
                        { projection: { userId: 1 } }
                    );
                    if (doc && doc.userId) {
                        userId = doc.userId.toString();
                        console.log(`userId recuperado do documento para _id ${docId}: ${userId}`);
                        userIdCache.set(docId, userId);
                    } else {
                        // Fallback para cache
                        userId = userIdCache.get(docId);
                        if (userId) {
                            console.log(`userId recuperado do cache para _id ${docId}: ${userId}`);
                        } else {
                            console.warn(`Nenhum userId encontrado para _id ${docId} em registeredUsers ou cache. Ação abortada.`);
                            return;
                        }
                    }
                } catch (err) {
                    console.error(`Erro ao buscar userId para _id ${docId} em registeredUsers:`, err);
                    return;
                }
            }

            if (!userId) {
                console.warn(`Não foi possível determinar o userId para _id ${docId} em registeredUsers. Ação abortada.`);
                return;
            }

            const guild = await client.guilds.fetch(GUILD_ID).catch(err => {
                console.error('Erro ao buscar guild:', err);
                return null;
            });
            if (!guild) return;

            const member = await guild.members.fetch(userId).catch(err => {
                console.error(`Erro ao buscar membro ${userId}:`, err);
                return null;
            });
            if (!member) return;
            
            const excluidosChannel = await guild.channels.fetch(EXCLUIDOS_ID).catch(err => {
                console.error('Erro ao buscar canal de excluídos:', err);
                return null;
            });

            const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');

            if (change.operationType === 'delete') {
                console.log(`Usuário excluído para userId ${userId}`);
                try {
                    const botMember = await guild.members.fetch(client.user.id);
                    const botHighestRole = botMember.roles.highest;
                    const rolesToRemove = [REGISTRADO_ROLE_ID, VIP_ROLE_ID, AGUARDANDO_PAGAMENTO_ROLE_ID];
            
                    for (const roleId of rolesToRemove) {
                        const role = await guild.roles.fetch(roleId).catch(err => null);
                        if (role && botHighestRole.position > role.position) {
                            await member.roles.remove(roleId).catch(err => console.error(`Erro ao remover cargo ${roleId} para ${userId}:`, err));
                            console.log(`Cargo ${roleId} removido para ${userId}`);
                        } else {
                            console.error(`Bot não tem permissão para remover ${roleId} (hierarquia insuficiente) para ${userId}`);
                        }
                    }
            
                    // Remover do cache
                    userIdCache.delete(docId);

                    // Limpar expirationDates e notificationSent
                    await expirationDates.deleteOne({ userId });
                    await notificationSent.deleteMany({ userId });
                } catch (err) {
                    console.error(`Erro ao remover cargos para ${userId}:`, err);
                    if (excluidosChannel) {
                        const errorEmbed = new EmbedBuilder()
                            .setTitle('⚠️ Erro ao Processar Exclusão')
                            .setDescription(`Falha ao remover cargos para <@${userId}> após exclusão.`)
                            .addFields([
                                { name: 'Usuário', value: `${member.user.tag} (ID: ${userId})`, inline: false },
                                { name: 'Erro', value: err.message, inline: false },
                            ])
                            .setColor('#FF0000')
                            .setTimestamp();
                        await excluidosChannel.send({ embeds: [errorEmbed] });
                    }
                }

                if (excluidosChannel) {
                    const embed = new EmbedBuilder()
                        .setTitle('🚫 Usuário Excluído')
                        .setDescription(`O usuário <@${userId}> foi excluído via painel e seus cargos foram removidos.`)
                        .addFields([
                            { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                            { name: '🆔 ID', value: userId, inline: true },
                            { name: '🕒 Horário', value: horario, inline: true },
                        ])
                        .setColor('#FF0000')
                        .setTimestamp();
                    await excluidosChannel.send({ embeds: [embed] });
                }
            }
        });

        changeStream.on('error', (err) => {
            console.error('Erro no Change Stream de registeredUsers:', err);
            setTimeout(setupRegisteredUsersChangeStream, 10000);
        });
    } catch (err) {
        console.error('Erro ao configurar Change Stream de registeredUsers:', err);
        setTimeout(setupRegisteredUsersChangeStream, 10000);
    }
}

// Função auxiliar para calcular dias restantes
function calculateDaysLeft(expirationDate, now) {
    const expDate = new Date(expirationDate);
    if (isNaN(expDate.getTime())) return -1; // Data inválida
    const diffTime = expDate - now;
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// Função para verificar expirações de todos os usuários
async function checkAllExpirations() {
    try {
        if (!expirationDates) {
            console.error('Coleção expirationDates não disponível. Verificação cancelada.');
            return;
        }

        const now = new Date();
        const expirationDocs = await expirationDates.find({}).toArray();
        console.log(`Verificando ${expirationDocs.length} documentos de expiração às ${now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);

        if (expirationDocs.length === 0) {
            console.log('Nenhum documento em expirationDates. Verificação concluída.');
            return;
        }

        for (const doc of expirationDocs) {
            const { userId, expirationDate } = doc;
            if (!userId || !expirationDate) {
                console.warn(`Documento inválido encontrado: ${JSON.stringify(doc)}`);
                continue;
            }

            const daysLeft = calculateDaysLeft(expirationDate, now);
            if (daysLeft <= 3) {
                console.log(`Verificando expiração para userId ${userId}: ${daysLeft} dias restantes`);
                await checkExpirationNow(userId, expirationDate);
            }
        }
    } catch (err) {
        console.error('Erro ao verificar expirações:', err.message, err.stack);
    }
}

// Função para iniciar a verificação de expirações
async function startExpirationCheck() {
    if (expirationCheckInterval.size > 0) {
        clearInterval(expirationCheckInterval.get('global'));
        expirationCheckInterval.delete('global');
        console.log('Intervalo de verificação anterior cancelado');
    }

    const interval = setInterval(async () => {
        await checkAllExpirations();
    }, 10 * 60 * 1000); // <-- CORRIGIDO: Intervalo de 10 minutos

    expirationCheckInterval.set('global', interval);
    console.log('Intervalo de verificação global iniciado (10 minutos)'); // <-- CORRIGIDO: Log atualizado

    console.log('A primeira verificação de expirações foi agendada para daqui a 1 minuto.');
    setTimeout(async () => {
        console.log('[Agendado] Executando a primeira verificação de expirações...');
        await checkAllExpirations();
    }, 60 * 1000);
}
// Função auxiliar para verificar expiração imediatamente
async function checkExpirationNow(userId, expirationDate) {
    const now = new Date();
    const daysLeft = calculateDaysLeft(expirationDate, now);
    console.log(`[${new Date(now).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}] Verificando expiração para ${userId}: ${daysLeft} dias restantes`);

    const guild = await client.guilds.fetch(GUILD_ID).catch(err => {
        console.error('Erro ao buscar guild:', err);
        return null;
    });
    if (!guild) return;

    const member = await guild.members.fetch(userId).catch(err => {
        console.warn(`Usuário ${userId} não encontrado no servidor. Removendo dados de expiração. Erro: ${err.message}`);
        // Remover dados de expiração e notificação para usuários ausentes
        expirationDates.deleteOne({ userId }).catch(err => console.error(`Erro ao remover expiração para ${userId}:`, err));
        notificationSent.deleteMany({ userId }).catch(err => console.error(`Erro ao remover notificações para ${userId}:`, err));
        return null;
    });
    if (!member) return;

    const horario = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');

    // Notificação para 3 dias restantes
    if (daysLeft <= 3 && daysLeft > 2) {
        console.log(`[Debug] Condição de 3 dias atendida para ${userId}, daysLeft: ${daysLeft}`);
        const alreadyNotified = await notificationSent.findOne({ userId, type: '3days' });
        if (!alreadyNotified) {
            const channelName = `expiracao-${member.user.username.toLowerCase()}-3dias`;
            let expirationChannel = guild.channels.cache.find(ch => ch.name === channelName);

            try {
                if (!expirationChannel) {
                    try {
                        expirationChannel = await guild.channels.create({
                            name: channelName,
                            type: ChannelType.GuildText,
                            parent: CATEGORIA_EXPIRATIONS_ID,
                            permissionOverwrites: [
                                { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                                { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                                { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
                            ],
                        });
                        console.log(`Canal de expiração criado para ${userId}: ${channelName}`);
                    } catch (err) {
                        console.error(`Erro ao criar canal de expiração ${channelName} para ${userId}:`, err);
                        return; // Aborta a execução se o canal não puder ser criado
                    }
                }

                const notifyEmbed = new EmbedBuilder()
                    .setTitle('⚠️ Lembrete: 3 Dias para Expiração')
                    .setDescription(`Sua assinatura VIP está prestes a expirar em ${daysLeft} dias! Renove agora acessando o canal de pagamentos.`)
                    .addFields([
                        { name: '👤 Usuário', value: `${member.user.tag}`, inline: true },
                        { name: '🆔 ID', value: userId, inline: true },
                        { name: '🕒 Horário da Notificação', value: horario, inline: true },
                    ])
                    .setColor('#FFA500')
                    .setTimestamp();

                await expirationChannel.send({
                    content: `<@${userId}>`,
                    embeds: [notifyEmbed],
                });
                await notificationSent.insertOne({ userId, type: '3days', notifiedAt: new Date() });
                setTimeout(async () => {
                    try {
                        if (expirationChannel) {
                            await expirationChannel.delete('Notificação de expiração expirada (12h)');
                            console.log(`Canal de expiração ${channelName} deletado para ${userId}`);
                        }
                    } catch (err) {
                        console.error(`Erro ao deletar canal de expiração ${channelName} para ${userId}:`, err);
                    }
                }, 12 * 60 * 60 * 1000); // 12 horas

                const notificationsChannel = await guild.channels.fetch(NOTIFICACOES_ID).catch(err => {
                    console.error('Erro ao buscar canal de notificações:', err);
                    return null;
                });
                if (notificationsChannel) {
                    const publicNotifyEmbed = new EmbedBuilder()
                        .setTitle('⚠️ Lembrete: 3 Dias para Expiração')
                        .setDescription(`A assinatura de <@${userId}> está prestes a expirar em ${daysLeft} dias!`)
                        .addFields([
                            { name: '👤 Usuário', value: `${member.user.tag}`, inline: true },
                            { name: '🆔 ID', value: userId, inline: true },
                            { name: '🕒 Horário da Notificação', value: horario, inline: true },
                        ])
                        .setColor('#FFA500')
                        .setTimestamp();
                    await notificationsChannel.send({ embeds: [publicNotifyEmbed], content: `<@${userId}>` });
                }
            } catch (err) {
                console.error(`Erro ao processar notificação de 3 dias para ${userId}:`, err);
            }
        }
    }

    // Notificação para 1 dia restante
    if (daysLeft === 1) {
        console.log(`[Debug] Condição de 1 dia atendida para ${userId}, daysLeft: ${daysLeft}`);
        const alreadyNotified = await notificationSent.findOne({ userId, type: '1day' });
        if (!alreadyNotified) {
            const channelName = `expiracao-${member.user.username.toLowerCase()}-1dia`;
            let expirationChannel = guild.channels.cache.find(ch => ch.name === channelName);

            try {
                if (!expirationChannel) {
                    expirationChannel = await guild.channels.create({
                        name: channelName,
                        type: ChannelType.GuildText,
                        parent: CATEGORIA_EXPIRATIONS_ID,
                        permissionOverwrites: [
                            { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                            { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                            { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
                        ],
                    });
                    console.log(`Canal de expiração criado para ${userId}: ${channelName}`);
                }

                const notifyEmbed = new EmbedBuilder()
                    .setTitle('⏳ Lembrete: 1 Dia para Expiração')
                    .setDescription(`Sua assinatura VIP está prestes a expirar em ${daysLeft} dia! Renove agora acessando o canal de pagamentos.`)
                    .addFields([
                        { name: '👤 Usuário', value: `${member.user.tag}`, inline: true },
                        { name: '🆔 ID', value: userId, inline: true },
                        { name: '🕒 Horário da Notificação', value: horario, inline: true },
                    ])
                    .setColor('#FF4500')
                    .setTimestamp();

                await expirationChannel.send({
                    content: `<@${userId}>`,
                    embeds: [notifyEmbed],
                });
                await notificationSent.insertOne({ userId, type: '1day', notifiedAt: new Date() });
                setTimeout(async () => {
                    try {
                        if (expirationChannel) {
                            await expirationChannel.delete('Notificação de expiração expirada (12h)');
                            console.log(`Canal de expiração ${channelName} deletado para ${userId}`);
                        }
                    } catch (err) {
                        console.error(`Erro ao deletar canal de expiração ${channelName} para ${userId}:`, err);
                    }
                }, 12 * 60 * 60 * 1000); // 12 horas

                const notificationsChannel = await guild.channels.fetch(NOTIFICACOES_ID).catch(err => {
                    console.error('Erro ao buscar canal de notificações:', err);
                    return null;
                });
                if (notificationsChannel) {
                    const publicNotifyEmbed = new EmbedBuilder()
                        .setTitle('⏳ Lembrete: 1 Dia para Expiração')
                        .setDescription(`A assinatura de <@${userId}> está prestes a expirar em ${daysLeft} dia!`)
                        .addFields([
                            { name: '👤 Usuário', value: `${member.user.tag}`, inline: true },
                            { name: '🆔 ID', value: userId, inline: true },
                            { name: '🕒 Horário da Notificação', value: horario, inline: true },
                        ])
                        .setColor('#FF4500')
                        .setTimestamp();
                    await notificationsChannel.send({ embeds: [publicNotifyEmbed], content: `<@${userId}>` });
                }
            } catch (err) {
                console.error(`Erro ao processar notificação de 1 dia para ${userId}:`, err);
            }
        }
    }

    // Notificação de expiração
    if (daysLeft <= 0) {
        const CUSTO_PLANO_TRIMESTRAL = 1200;
        const CUSTO_PLANO_MENSAL = 1;
        const CUSTO_PLANO_SEMANAL = 200;
    
        const balanceDoc = await userBalances.findOne({ userId });
        const saldoDisponivel = balanceDoc ? Number(balanceDoc.balance) : 0;
    
        let renewed = false;
        let renewalDetails = {};
    
        // --- LÓGICA DE RENOVAÇÃO AUTOMÁTICA CORRIGIDA E PRIORIZADA ---
        // 1. Tenta renovar o plano TRIMESTRAL primeiro
        if (saldoDisponivel >= CUSTO_PLANO_TRIMESTRAL) {
            renewed = true;
            renewalDetails = { plan: 'Trimestral', cost: CUSTO_PLANO_TRIMESTRAL, duration: 90 };
        // 2. Senão, tenta renovar o plano MENSAL
        } else if (saldoDisponivel >= CUSTO_PLANO_MENSAL) {
            renewed = true;
            renewalDetails = { plan: 'Mensal', cost: CUSTO_PLANO_MENSAL, duration: 30 };
        // 3. Senão, tenta renovar o plano SEMANAL
        } else if (saldoDisponivel >= CUSTO_PLANO_SEMANAL) {
            renewed = true;
            renewalDetails = { plan: 'Semanal', cost: CUSTO_PLANO_SEMANAL, duration: 7 };
        }
    
        if (renewed) {
            console.log(`[Auto-Renovação] Saldo suficiente para o plano ${renewalDetails.plan}. Renovando para ${userId}...`);
            try {
                await userBalances.updateOne({ userId }, { $inc: { balance: -renewalDetails.cost } });
    
                const newExpirationDate = new Date();
                newExpirationDate.setDate(newExpirationDate.getDate() + renewalDetails.duration);
                await expirationDates.updateOne({ userId }, { $set: { expirationDate: newExpirationDate } });
                
                // Lógica de log e notificação para o usuário (DM)
                const logChannel = await guild.channels.fetch(LOGS_BOTS_ID);
                if (logChannel) {
                    const logEmbed = new EmbedBuilder()
                        .setTitle('🔄 Assinatura Renovada Automaticamente')
                        .setDescription(`A assinatura de <@${userId}> foi renovada usando o saldo de bônus.`)
                        .setColor('#00BFFF')
                        .addFields(
                            { name: 'Plano Renovado', value: renewalDetails.plan, inline: true },
                            { name: '💰 Saldo Utilizado', value: `R$ ${renewalDetails.cost.toFixed(2)}`, inline: true },
                            { name: '🗓️ Nova Expiração', value: newExpirationDate.toLocaleDateString('pt-BR') }
                        )
                        .setTimestamp();
                    await logChannel.send({ embeds: [logEmbed] });
                }
                await member.send({
                    embeds: [
                        new EmbedBuilder()
                            .setTitle('✅ Assinatura Renovada!')
                            .setDescription(`Sua assinatura VIP foi renovada automaticamente por mais **${renewalDetails.duration} dias** (Plano ${renewalDetails.plan}) utilizando seu saldo.`)
                            .setColor('#00FF00')
                            .setTimestamp()
                    ]
                }).catch(err => console.error(`Falha ao enviar DM de auto-renovação para ${userId}:`, err));
                await notificationSent.deleteMany({ userId });
    
            } catch (err) {
                console.error(`[Auto-Renovação] Erro crítico ao renovar para ${userId}:`, err);
            }
        } else {
        // --- LÓGICA DE EXPIRAÇÃO SEGURA ---
        console.log(`[Expiração] Saldo insuficiente para ${userId}. Removendo cargos.`);
        try {
            const botMember = await guild.members.fetch(client.user.id);
            const botHighestRole = botMember.roles.highest;
            const vipRole = await guild.roles.fetch(VIP_ROLE_ID);
            const aguardandoRole = await guild.roles.fetch(AGUARDANDO_PAGAMENTO_ROLE_ID);

            // REMOVE O CARGO VIP
            if (botHighestRole.position > vipRole.position) {
                await member.roles.remove(VIP_ROLE_ID);
                console.log(`VIP removido para ${userId}`);
            } else {
                throw new Error(`Bot não tem permissão para remover VIP (hierarquia insuficiente) para ${userId}`);
            }

            // ADICIONA O CARGO DE AGUARDANDO PAGAMENTO
            if (botHighestRole.position > aguardandoRole.position) {
                await member.roles.add(AGUARDANDO_PAGAMENTO_ROLE_ID);
                console.log(`AGUARDANDO_PAGAMENTO adicionado para ${userId}`);
            } else {
                throw new Error(`Bot não tem permissão para adicionar AGUARDANDO_PAGAMENTO (hierarquia insuficiente) para ${userId}`);
            }

            // LIMPEZA DO BANCO DE DADOS
            await expirationDates.deleteOne({ userId });
            await notificationSent.deleteMany({ userId });
            console.log(`Registros de expiração limpos para ${userId}.`);

            // ETAPA 3: NOTIFICAR O USUÁRIO E OS CANAIS PÚBLICOS
            const channelName = `expiracao-${member.user.username.toLowerCase()}-expirada`;
            let expirationChannel = guild.channels.cache.find(ch => ch.name === channelName);

            if (!expirationChannel) {
                expirationChannel = await guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildText,
                    parent: CATEGORIA_EXPIRATIONS_ID,
                    permissionOverwrites: [
                        { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                        { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                        { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels, PermissionsBitField.Flags.ReadMessageHistory] },
                    ],
                });
                console.log(`Canal de expiração criado para ${userId}: ${channelName}`);
            }

            const expireEmbed = new EmbedBuilder()
                .setTitle('⏳ Assinatura Vencida')
                .setDescription(`Sua assinatura VIP expirou. Renove agora acessando o canal de pagamentos.`)
                .addFields(
                    { name: '👤 Usuário', value: `${member.user.tag}`, inline: true },
                    { name: '🆔 ID', value: userId, inline: true },
                    { name: '🕒 Horário', value: horario, inline: true },
                )
                .setColor('#FF0000')
                .setTimestamp();

            await expirationChannel.send({ content: `<@${userId}>`, embeds: [expireEmbed] });

            setTimeout(async () => {
                try {
                    if (expirationChannel && guild.channels.cache.has(expirationChannel.id)) {
                        await expirationChannel.delete('Notificação de expiração concluída (12h)');
                        console.log(`Canal de expiração ${channelName} deletado para ${userId}`);
                    }
                } catch (err) {
                    console.error(`Erro ao deletar canal de expiração ${channelName} para ${userId}:`, err);
                }
            }, 12 * 60 * 60 * 1000);

            const notificationsChannel = await guild.channels.fetch(NOTIFICACOES_ID).catch(() => null);
            if (notificationsChannel) {
                const publicExpireEmbed = new EmbedBuilder()
                    .setTitle('⏳ Assinatura Vencida')
                    .setDescription(`A assinatura de <@${userId}> expirou.`)
                    .addFields(
                        { name: '👤 Usuário', value: `${member.user.tag}`, inline: false },
                        { name: '🆔 ID', value: userId, inline: true },
                        { name: '🕒 Horário', value: horario, inline: true },
                    )
                    .setColor('#FF0000')
                    .setTimestamp();
                await notificationsChannel.send({ embeds: [publicExpireEmbed], content: `<@${userId}>` });
            }
        } catch (err) {
            console.error(`[FALHA CRÍTICA] Erro ao processar expiração para ${userId}. O registro de expiração NÃO foi removido para que o bot tente novamente no próximo ciclo.`, err);
        }
    }
}
}

async function auditVipRoles() {
    console.log('[Auditoria] Iniciando auditoria de cargos VIP...');
    try {
        const guild = await client.guilds.fetch(GUILD_ID);
        const vipRole = await guild.roles.fetch(VIP_ROLE_ID);
        if (!vipRole) {
            console.error("[Auditoria] Cargo VIP não encontrado. Auditoria cancelada.");
            return;
        }

        // Otimização: Busca direta dos membros do cargo, em vez de todos os membros do servidor.
        // Isso é muito mais rápido e eficiente em servidores grandes.
        await guild.members.fetch(); // Garante que o cache de membros do cargo esteja atualizado
        const membersWithVipRole = vipRole.members;

        console.log(`[Auditoria] Encontrados ${membersWithVipRole.size} membros com o cargo VIP para verificar.`);

        for (const [memberId, member] of membersWithVipRole) {
            // Para cada membro, verifica se ele tem uma assinatura válida no banco de dados
            const expirationRecord = await expirationDates.findOne({ userId: memberId });
            const now = new Date();

            if (!expirationRecord || new Date(expirationRecord.expirationDate) <= now) {
                // Se não houver registro de assinatura ou se ela já expirou...
                console.warn(`[Auditoria] INCONSISTÊNCIA ENCONTRADA: Usuário ${member.user.tag} (ID: ${memberId}) possui o cargo VIP, mas não tem uma assinatura ativa. Removendo cargo...`);
                
                try {
                    await member.roles.remove(VIP_ROLE_ID);
                    await member.roles.add(AGUARDANDO_PAGAMENTO_ROLE_ID);
                    console.log(`[Auditoria] Cargo VIP removido e AGUARDANDO_PAGAMENTO adicionado para ${member.user.tag}.`);
                    
                    const logChannel = await guild.channels.fetch(LOGS_BOTS_ID);
                    if (logChannel) {
                        const embed = new EmbedBuilder()
                            .setTitle('🛡️ Auditoria de Segurança')
                            .setDescription(`O cargo VIP de <@${memberId}> foi removido por inconsistência.`)
                            .addFields(
                                { name: 'Motivo', value: 'Não possuía uma assinatura ativa correspondente no banco de dados.' }
                            )
                            .setColor('#FFA500')
                            .setTimestamp();
                        await logChannel.send({ embeds: [embed] });
                    }
                } catch (err) {
                    console.error(`[Auditoria] Falha ao corrigir cargos para ${member.user.tag}:`, err);
                }
            }
        }
        console.log('[Auditoria] Auditoria de cargos VIP concluída.');
    } catch (err) {
        console.error('[Auditoria] Erro crítico durante a auditoria de cargos VIP:', err);
    }
}
// =================================================================================
// ROTAS DA API (DO ANTIGO server.js)
// =================================================================================

app.get('/', (req, res) => {
    res.status(200).send('API e da Comunidade Money Services estão online e funcionando!');
});

// createPagBankPayment - VERSÃO FINAL COM DADOS DO CLIENTE
async function createPagBankPayment(userId, valor, duration, saldoUtilizado = 0, customerName, customerPhone) {
    console.log(`[PagBank API] Iniciando pagamento para userId: ${userId}, valor: ${valor}`);
    try {
        const valorEmCentavos = Math.round(Number(valor) * 100);
        const accessToken = process.env.PAGBANK_TOKEN;
        const url = 'https://api.pagseguro.com/charges';

        // Extrai o DDD e o número do WhatsApp
        const areaCode = customerPhone.substring(0, 2);
        const phoneNumber = customerPhone.substring(2);

        const paymentData = {
            reference_id: `user-${userId}-${Date.now()}`,
            description: `Taxa de acesso (${duration} dias)`,
            amount: {
                value: valorEmCentavos,
                currency: 'BRL'
            },
            // =============================================================
            // CORREÇÃO FINAL APLICADA
            // Adicionado o objeto 'customer' obrigatório para produção.
            // =============================================================
            customer: {
                name: customerName,
                // O PagBank exige um e-mail, podemos usar um genérico se não o coletamos.
                email: `${userId}@discord-user.com`, 
                phones: [{
                    country: "55",
                    area: areaCode,
                    number: phoneNumber,
                    type: "MOBILE"
                }]
            },
            payment_method: {
                type: 'PIX',
                pix: {
                    expires_in: 600, // 10 minutos
                }
            },
            notification_urls: [`${process.env.APP_URL}/webhook-pagbank`],
            metadata: {
                userId: userId,
                balance_used: saldoUtilizado,
                plan_duration: duration,
            },
        };

        const headers = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`,
            'x-api-version': '4.0'
        };

        console.log('[PagBank API] [ETAPA 1/3] Enviando requisição para a API do PagBank...');
        const response = await axios.post(url, paymentData, { headers });
        const result = response.data;
        console.log('[PagBank API] [ETAPA 2/3] Resposta recebida da API do PagBank com sucesso.');

        const pixData = result.qr_codes[0];
        if (!pixData || !pixData.text) {
            throw new Error('Resposta da API do PagBank não contém os dados do PIX esperados.');
        }

        const qrCodeBase64 = await QRCode.toDataURL(pixData.text);
        const paymentInfo = {
            paymentId: result.id,
            qrCodeBase64: qrCodeBase64.replace('data:image/png;base64,', ''),
            copiaECola: pixData.text,
        };

        console.log('[PagBank API] [ETAPA 3/3] Pagamento processado e dados retornados.');
        return paymentInfo;

    } catch (error) {
        console.error('[PagBank API] ERRO CRÍTICO ao se comunicar com a API do PagBank.');
        if (error.response) {
            console.error('Detalhes do erro da API:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Detalhes completos do erro de comunicação:', error.message);
        }
        throw new Error('Falha ao se comunicar com a API de pagamentos do PagBank.');
    }
}
// =================================================================================
// NOVO WEBHOOK - PAGBANK
// =================================================================================
app.post('/webhook-pagbank', async (req, res) => {
    const notification = req.body;
    console.log('[API] Webhook do PagBank recebido:', JSON.stringify(notification, null, 2));

    // Responde imediatamente ao PagBank para confirmar o recebimento
    res.sendStatus(200);

    // A notificação de PIX pago vem com o tipo 'charge.paid'
    if (notification && notification.type === 'charge.paid' && notification.charges && notification.charges.length > 0) {
        try {
            const chargeId = notification.charges[0].id; // Pega o ID da cobrança
            console.log(`[Webhook PagBank] Processando charge.paid para o ID: ${chargeId}`);

            // Busca os detalhes completos da cobrança na API do PagBank
            const accessToken = process.env.PAGBANK_TOKEN;
            const url = `https://api.pagseguro.com/charges/${chargeId}`;
            const headers = { 'Authorization': `Bearer ${accessToken}` };
            const response = await axios.get(url, { headers });
            const chargeDetails = response.data;

            // Pega os metadados que enviamos ao criar a cobrança
            const metadata = chargeDetails.metadata;
            if (!metadata || !metadata.userId || !metadata.plan_duration) {
                console.error('[Webhook PagBank] ERRO: Metadados essenciais (userId, plan_duration) não encontrados na cobrança.', chargeDetails);
                return;
            }

            const userId = metadata.userId;
            const valorPago = chargeDetails.amount.value / 100; // Converte de centavos para reais
            const planCode = Number(metadata.plan_duration);
            const balanceUsed = metadata.balance_used ? Number(metadata.balance_used) : 0;
            const paymentReference = `PB-${chargeId}`;
            const now = new Date();

            // Verificação de Idempotência: Checa se já processamos este pagamento
            const alreadyProcessed = await registeredUsers.findOne({ 'paymentHistory.reference': paymentReference });
            if (alreadyProcessed) {
                console.log(`[Webhook PagBank] Pagamento ${paymentReference} já processado anteriormente. Ignorando.`);
                return;
            }

            const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
            if (!guild) return;

            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) {
                console.warn(`[Webhook PagBank] Membro ${userId} não encontrado no servidor.`);
                return;
            }

            // Lógica de Ativação/Renovação (similar à do Mercado Pago)
            let newExpirationDate;
            const existingExpiration = await expirationDates.findOne({ userId });

            if (existingExpiration && new Date(existingExpiration.expirationDate) > now) {
                newExpirationDate = new Date(existingExpiration.expirationDate);
            } else {
                newExpirationDate = new Date(now);
            }
            newExpirationDate.setDate(newExpirationDate.getDate() + planCode);

            await expirationDates.updateOne({ userId }, { $set: { expirationDate: newExpirationDate } }, { upsert: true });
            await member.roles.add(VIP_ROLE_ID);
            await member.roles.remove(AGUARDANDO_PAGAMENTO_ROLE_ID);

            // Lógica de Bônus por Indicação (semelhante)
            const payingUserDoc = await registeredUsers.findOne({ userId });
            if (payingUserDoc && payingUserDoc.referredBy && !payingUserDoc.referralBonusPaid) {
                // Verifica se é o primeiro pagamento do usuário
                const paymentCount = await paymentHistory.countDocuments({ userId });
                if (paymentCount === 0) {
                    const referrerId = payingUserDoc.referredBy;

                    const VALOR_TRIMESTRAL = 1200;
                    const VALOR_MENSAL = 1;
                    const VALOR_SEMANAL = 200;
                    const BONUS_TRIMESTRAL = 600;
                    const BONUS_MENSAL = 250;
                    const BONUS_SEMANAL = 100;

                    let bonusAmount = 0;
                    if (valorPago + balanceUsed === VALOR_TRIMESTRAL) bonusAmount = BONUS_TRIMESTRAL;
                    else if (valorPago + balanceUsed === VALOR_MENSAL) bonusAmount = BONUS_MENSAL;
                    else if (valorPago + balanceUsed === VALOR_SEMANAL) bonusAmount = BONUS_SEMANAL;

                    if (bonusAmount > 0) {
                        await userBalances.updateOne({ userId: referrerId }, { $inc: { balance: bonusAmount } }, { upsert: true });
                        await registeredUsers.updateOne({ userId }, { $set: { referralBonusPaid: true } });
                        console.log(`[Webhook PagBank] Bônus de R$ ${bonusAmount} creditado para o indicador ${referrerId}.`);
                    }
                }
            }

            // Salva o histórico de pagamento
            await paymentHistory.insertOne({
                userId: userId,
                amount: valorPago,
                balanceUsed: balanceUsed,
                plan: `${planCode} dias`,
                reference: paymentReference,
                gateway: 'PagBank',
                timestamp: now,
            });
             // Atualiza o registro principal do usuário (opcional, mas bom para consistência)
            await registeredUsers.updateOne({ userId }, { $push: { paymentHistory: { amount: valorPago, timestamp: now, reference: paymentReference } } });


            // Notificação para o usuário
            const confirmationEmbed = new EmbedBuilder()
                .setTitle('✅ Pagamento Confirmado!')
                .setColor('#00FF00').setTimestamp().setFooter({ text: 'Agradecemos a sua preferência!' });

            if (balanceUsed > 0) {
                confirmationEmbed.setDescription(`Pagamento processado com sucesso utilizando seu saldo de bônus!`)
                    .addFields(
                        { name: '💰 Saldo Utilizado', value: `R$ ${balanceUsed.toFixed(2)}`, inline: true },
                        { name: '💸 Valor Pago (PIX)', value: `R$ ${valorPago.toFixed(2)}`, inline: true }
                    );
            } else {
                confirmationEmbed.setDescription('Sua assinatura VIP foi ativada/renovada com sucesso!');
            }

            confirmationEmbed.addFields(
                { name: '⏳ Duração Adicionada', value: `${planCode} dias`, inline: false },
                { name: '🗓️ Assinatura Expira em', value: newExpirationDate.toLocaleDateString('pt-BR') }
            );

            const channelRecord = await activePixChannels.findOne({ userId: userId });
            if (channelRecord && channelRecord.channelId) {
                const paymentChannel = await guild.channels.fetch(channelRecord.channelId).catch(() => null);
                if (paymentChannel) {
                    await paymentChannel.send({ content: `<@${userId}>`, embeds: [confirmationEmbed] });
                } else {
                    await member.send({ embeds: [confirmationEmbed] }).catch(() => {});
                }
                await activePixChannels.deleteOne({ userId: userId });
            } else {
                await member.send({ embeds: [confirmationEmbed] }).catch(() => {});
            }

            // Log para a administração
            try {
                // --- ADICIONE ESTA LINHA PARA CORRIGIR O ERRO ---
                const horarioFormatado = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');
            
                // 1. Log para o canal geral de pagamentos (sempre envia)
                const logPagamentosChannel = await guild.channels.fetch(LOG_PAGAMENTOS_ID);
                if (logPagamentosChannel) {
                    const embedLog = new EmbedBuilder()
                        .setTitle('💰 Pagamento Aprovado (PagBank)')
                        .setColor('#00FF00')
                        .addFields(
                            { name: '👤 Usuário', value: `<@${userId}> (ID: ${userId})` },
                            { name: '💸 Valor', value: `R$${valorPago.toFixed(2)}`, inline: true },
                            { name: '📝 Referência', value: `\`${chargeId}\``, inline: true },
                            { name: '⏳ Duração', value: `${planCode} dias`, inline: true }
                        ).setTimestamp();
                    await logPagamentosChannel.send({ embeds: [embedLog] });
                }
            
                // 2. Log para o canal de logs do bot (lógica condicional)
                if (balanceUsed && balanceUsed > 0) {
                    // Lógica para quando o SALDO É USADO
                    try {
                        await userBalances.updateOne({ userId: userId }, { $inc: { balance: -balanceUsed } });
                        console.log(`[Webhook] Saldo deduzido: R$ ${Number(balanceUsed).toFixed(2)} para ${userId}.`);
                        
                        const logChannel = await guild.channels.fetch(LOGS_BOTS_ID);
                        const renewalWithBalanceEmbed = new EmbedBuilder()
                            .setTitle('💳 Assinatura Renovada com Saldo')
                            .setDescription(`A assinatura de <@${userId}> foi renovada utilizando o saldo de bônus.`)
                            .setColor('#FFC300')
                            .addFields(
                                { name: '👤 Usuário', value: `<@${userId}> (ID: ${userId})` },
                                { name: '💰 Saldo Utilizado', value: `R$ ${Number(balanceUsed).toFixed(2)}`, inline: true },
                                { name: '💸 Valor Pago (PIX)', value: `R$ ${valorPago.toFixed(2)}`, inline: true }
                            )
                            .setTimestamp();
                        await logChannel.send({ embeds: [renewalWithBalanceEmbed] });
                    } catch (err) {
                        console.error(`[Webhook] ERRO ao deduzir saldo ou logar para ${userId}:`, err);
                    }
                } else {
                    // Lógica para quando o SALDO NÃO É USADO
                    try {
                        const logBotsChannel = await guild.channels.fetch(LOGS_BOTS_ID); // Usando uma variável diferente para evitar conflito
                        const embedAssinaturaRenovada = new EmbedBuilder()
                            .setTitle('🔄 Assinatura Renovada')
                            .setDescription('A assinatura de um usuário foi renovada!')
                            .setColor('#00BFFF')
                            .addFields(
                                { name: '👤 Usuário', value: `\`${member.user.username}\`` },
                                { name: '🆔 ID', value: `\`${userId}\``, inline: true },
                                { name: '🕒 Horário', value: `\`${horarioFormatado}\``, inline: true }, // AGORA FUNCIONA
                                { name: '✅ Papéis Atualizados', value: '`Sim`', inline: true }
                            )
                            .setTimestamp();
                        await logBotsChannel.send({ embeds: [embedAssinaturaRenovada] });
                    } catch (err) {
                        console.error("Erro ao enviar log de renovação genérico para LOGS_BOTS_ID:", err);
                    }
                }
            }catch (error) {
                console.error('[API] Erro CRÍTICO ao processar logs do webhook do PagBank', error);
            }
    }catch (error) {
        console.error('[API] Erro CRÍTICO.', error);
    }
}
});

// Quando o bot estiver online
client.once('clientReady', async () => {
    console.log(`✅ Bot online como ${client.user.tag}`);

    // --- INÍCIO DAS NOVAS CHAMADAS DE AUDITORIA ---
    
    /* 1. Executa a auditoria uma vez na inicialização
    console.log('[Inicialização] Executando auditoria inicial de cargos VIP...');
    await auditVipRoles();

    // 2. Agenda a auditoria para rodar a cada 6 horas
    setInterval(auditVipRoles, 6 * 60 * 60 * 1000);
    console.log('[Inicialização] Auditoria de cargos VIP agendada para ser executada a cada 6 horas.');

    *///--- FIM DAS NOVAS CHAMADAS DE AUDITORIA ---

    const guild = await client.guilds.fetch(GUILD_ID);

    // Painel de Registro
    const canalRegistro = await guild.channels.fetch(CANAL_REGISTRO_ID);

    await canalRegistro.permissionOverwrites.edit(guild.roles.everyone, {
        ViewChannel: true,
        SendMessages: false,
        ReadMessageHistory: true,
    });
    
    const embedRegistro = new EmbedBuilder()
        .setTitle('📝 Registro de Cliente')
        .setDescription('Clique no botão abaixo para se registrar e acessar o canal 🎰➧painel-clientes para adicionar seu saldo.')
        .setColor('#00BFFF');

    const botaoRegistro = new ButtonBuilder()
        .setCustomId('abrir_formulario')
        .setEmoji('📝')
        .setLabel('Registrar-se')
        .setStyle(ButtonStyle.Success);

    const rowRegistro = new ActionRowBuilder().addComponents(botaoRegistro);

    const mensagensRegistro = await canalRegistro.messages.fetch({ limit: 10 });
    const msgExistente = mensagensRegistro.find(m =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0].title === embedRegistro.data.title
    );

    if (!msgExistente) {
        const msg = await canalRegistro.send({ embeds: [embedRegistro], components: [rowRegistro] });
        await msg.pin();
    } else {
        await msgExistente.edit({ embeds: [embedRegistro], components: [rowRegistro] });
    }

    // Painel de Adicionar Saldo
    const canalPainel = await guild.channels.fetch(CANAL_PAINEL_ID);

    const embedPainel = new EmbedBuilder()
        .setTitle('📥 Painel de Cliente - Adição de Saldo')
        .setDescription(
            `Seja bem-vindo ao painel de adição de saldo! Aqui você pode adicionar créditos à sua carteira.\n\n` +
            `Clique nos botões abaixo para gerenciar sua conta:\n\n` +
            `📌 Como funciona?\n\nClique no botão abaixo para adicionar saldo à sua conta.\n\n` +
            `⚠️ Importante!\n\nAntes de fazer qualquer pagamento, lembre-se de que não há reembolsos para adição de créditos. \n\n` +
            `💰 Valores\n\nPara ativar sua assinatura pela primeira vez, você precisa ter pelo menos R$ 200,00 ou R$ 500,00 de saldo.\n\n` +
            `💡 *Se você não estiver registrado, clique em **#registrar-se** primeiro.*`
        )
        .setColor('#FFD700');

    const botaoAdicionarSaldo = new ButtonBuilder()
        .setCustomId('adicionar_saldo')
        .setEmoji('💰')
        .setLabel('Adicionar Saldo')
        .setStyle(ButtonStyle.Success);

    const botaoConsultarSaldo = new ButtonBuilder()
        .setCustomId('consultar_saldo')
        .setEmoji('🔍')
        .setLabel('Consultar Saldo')
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(botaoAdicionarSaldo, botaoConsultarSaldo);

    const mensagens = await canalPainel.messages.fetch({ limit: 10 });
    const mensagemFixa = mensagens.find(m =>
        m.author.id === client.user.id &&
        m.embeds.length > 0 &&
        m.embeds[0].title === embedPainel.data.title
    );

    if (!mensagemFixa) {
        const msg = await canalPainel.send({ embeds: [embedPainel], components: [row] });
        await msg.pin();
    } else {
        await mensagemFixa.edit({ embeds: [embedPainel], components: [row] });
    }

    // Iniciar verificação global de expirações
    if (expirationDates) {
        await startExpirationCheck();
    }
});

// Interações
client.on('interactionCreate', async (interaction) => {
    if (!registeredUsers || !userBalances || !paymentValues || !activePixChannels || !expirationDates || !notificationSent || !paymentHistory || !couponUsage) {
        console.error('Coleções não inicializadas. Aguardando reinicialização...');
        try {
            await interaction.reply({
                content: '❌ Ocorreu um erro interno. Tente novamente mais tarde.',
                flags: [MessageFlags.Ephemeral] 
            });
        } catch (err) {
            console.error('Erro ao responder interação de coleções não inicializadas:', err);
        }
        return;
    }

    // Botão de abrir formulário
    if (interaction.isButton() && interaction.customId === 'abrir_formulario') {
        const modal = new ModalBuilder()
            .setCustomId('formulario_registro')
            .setTitle('Registro de Cliente');

        const inputNome = new TextInputBuilder()
            .setCustomId('nome')
            .setLabel('Seu nome completo')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const inputWhatsapp = new TextInputBuilder()
            .setCustomId('whatsapp')
            .setLabel('Seu número')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('DDD900000000 (ex: 11912345678)')
            .setRequired(true);

        const row1 = new ActionRowBuilder().addComponents(inputNome);
        const row2 = new ActionRowBuilder().addComponents(inputWhatsapp);

        modal.addComponents(row1, row2);

        await interaction.showModal(modal);
    }

    // Formulário de registro enviado
    if (interaction.isModalSubmit() && interaction.customId === 'formulario_registro') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });
    try {
        const nome = interaction.fields.getTextInputValue('nome');
        const whatsapp = interaction.fields.getTextInputValue('whatsapp');

        const phoneRegex = /^\d{2}9\d{8}$/;
        if (!phoneRegex.test(whatsapp)) {
            // CORRIGIDO: Usando editReply
            await interaction.editReply({
                content: '❌ Número inválido! Use o formato brasileiro: DDD900000000 (ex: 11912345678).',
            });
            return;
        }

        const existingUser = await registeredUsers.findOne({ userId: interaction.user.id });
        if (existingUser) {
            // CORRIGIDO: Usando editReply
            await interaction.editReply({
                content: '❌ Você já está registrado!',
            });
            return;
        }

        const result = await registeredUsers.insertOne({
            userId: interaction.user.id,
            name: nome,
            whatsapp: whatsapp,
            registeredAt: new Date(),
            paymentHistory: []
        });
        const docId = result.insertedId.toString();
        userIdCache.set(docId, interaction.user.id);

        await userBalances.updateOne(
            { userId: interaction.user.id },
            { $set: { balance: 0 } },
            { upsert: true }
        );
        console.log(`Novo usuário registrado: ${nome}, para o ID ${interaction.user.id}`);

        let roleUpdateSuccess = false;
        try {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const botMember = await interaction.guild.members.fetch(client.user.id);
            const botRoles = botMember.roles.cache.map(r => ({ id: r.id, name: r.name, position: r.position }));
            const highestBotRole = botRoles.reduce((max, role) => role.position > max.position ? role : max, { position: -1 });
            const registeredRole = await interaction.guild.roles.fetch(REGISTRADO_ROLE_ID);
            const userRoles = member.roles.cache.map(r => ({ id: r.id, name: r.name, position: r.position }));

            if (highestBotRole.position <= (registeredRole?.position || 0)) {
                throw new Error('Bot não tem permissão suficiente para atribuir o cargo de registrado devido à hierarquia de papéis.');
            }

            const highestUserRole = userRoles.reduce((max, role) => role.position > max.position ? role : max, { position: -1 });
            if (highestUserRole.position >= highestBotRole.position) {
                throw new Error('Bot não pode gerenciar os papéis deste usuário devido a um cargo superior.');
            }

            await member.roles.add(REGISTRADO_ROLE_ID);
            console.log(`Papel ${REGISTRADO_ROLE_ID} adicionado ao usuário ${interaction.user.id}`);
            roleUpdateSuccess = true;
        } catch (roleError) {
            console.error(`Erro ao adicionar o cargo ${REGISTRADO_ROLE_ID} ao usuário ${interaction.user.id}:`, roleError);
            const logChannel = await interaction.guild.channels.fetch(LOGS_BOTS_ID);
            if (logChannel) {
                const errorEmbed = new EmbedBuilder()
                    .setTitle('⚠️ Erro ao Atribuir Cargo de Registro')
                    .setDescription(`Falha ao adicionar o cargo de registrado para <@${interaction.user.id}> durante o registro.`)
                    .addFields([
                        { name: 'Usuário', value: `${interaction.user.tag} (ID: ${interaction.user.id})`, inline: false },
                        { name: 'Erro', value: roleError.message, inline: false },
                    ])
                    .setColor('#FF0000')
                    .setTimestamp();
                await logChannel.send({ embeds: [errorEmbed] });
            }
            throw new Error('Falha ao adicionar o cargo de registrado. Um administrador foi notificado.');
        }

        const whatsappChannel = await interaction.guild.channels.fetch(CANAL_WHATSAPP_ID);
        if (whatsappChannel) {
            const currentTime = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false }).replace(', ', ' às ');
            const registrationEmbed = new EmbedBuilder()
                .setTitle('📝 Novo Registro')
                .addFields([
                    { name: 'Nome', value: nome, inline: true },
                    { name: 'Número', value: whatsapp, inline: true },
                ])
                .setFooter({ text: `Hoje às ${currentTime}` })
                .setColor('#00BFFF')
                .setTimestamp();
            await whatsappChannel.send({ embeds: [registrationEmbed] });
        }

        await interaction.editReply({
            content: `✅ Obrigado, ${nome}! Você foi registrado com sucesso. Seu saldo inicial é R$0.00.${roleUpdateSuccess ? '' : ' ⚠️ Porém, houve um erro ao atribuir seu cargo. Um administrador foi notificado.'}`,
        });
    } catch (err) {
        console.error('Erro ao processar o formulário:', err);
        try {
            // CORRIGIDO: Usando editReply
            await interaction.editReply({
                content: `❌ Ocorreu um erro ao processar seu registro: ${err.message}`,
            });
        } catch (replyErr) {
            console.error('Erro ao responder interação de formulário:', replyErr);
        }
    }
}

    // Botão de adicionar saldo
    if (interaction.isButton() && interaction.customId === 'adicionar_saldo') {
        try {
            const userExists = await registeredUsers.findOne({ userId: interaction.user.id });
            if (!userExists) {
                await interaction.reply({
                    content: '❌ Você precisa se registrar antes de adicionar saldo. Vá até **#registrar-se**.',
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }

            const modal = new ModalBuilder()
                .setCustomId('formulario_saldo')
                .setTitle('Adicionar Saldo');

            const inputValor = new TextInputBuilder()
                .setCustomId('valor')
                .setLabel('Valor desejado (ex: 200 ou 500 ou 1200)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Digite o valor em reais')
                .setRequired(false);

            const inputCupom = new TextInputBuilder()
                .setCustomId('cupom')
                .setLabel('Cupom / ID de Indicação (Opcional)')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Digite um cupom ou o ID de quem te indicou')
                .setRequired(false);

            const row1 = new ActionRowBuilder().addComponents(inputValor);
            const row2 = new ActionRowBuilder().addComponents(inputCupom);
            modal.addComponents(row1, row2);

            await interaction.showModal(modal);
        } catch (err) {
            console.error('Erro ao abrir formulário de saldo:', err);
            try {
                await interaction.reply({
                    content: '❌ Ocorreu um erro ao abrir o formulário de saldo.',
                    flags: [MessageFlags.Ephemeral]
                });
            } catch (replyErr) {
                console.error('Erro ao responder interação de adicionar saldo:', replyErr);
            }
        }
    }

    const newIndicationCoupons = ['CUPOM'];

// SUBSTITUA TODA A INTERAÇÃO 'formulario_saldo' POR ESTA
if (interaction.isModalSubmit() && interaction.customId === 'formulario_saldo') {
    await interaction.deferReply({ flags: [MessageFlags.Ephemeral] }).catch(err => console.error('Erro ao deferir resposta:', err));

    try {
        const valorInputStr = interaction.fields.getTextInputValue('valor');
        const cupomInput = interaction.fields.getTextInputValue('cupom')?.trim();
        const userId = interaction.user.id;
        const guild = interaction.guild;
        const member = await guild.members.fetch(userId).catch(() => null);
        let isIndicationId = false;
        const userDoc = await registeredUsers.findOne({ userId });

        // A função de log permanece a mesma
        const logCouponUsage = async (couponCode, title, description) => {
            try {
                const logCouponsChannel = await guild.channels.fetch(LOG_COUPONS_ID);
                const embed = new EmbedBuilder()
                    .setTitle(title).setDescription(description).setColor('#FFD700')
                    .addFields(
                        { name: '👤 Usuário', value: `\`${member.user.username} (ID: ${userId})\`` },
                        { name: '🎫 Código Utilizado', value: `\`${couponCode}\`` }
                    ).setTimestamp();
                await logCouponsChannel.send({ embeds: [embed] });
            } catch (err) { console.error(`Erro ao enviar log para LOG_COUPONS_ID:`, err); }
        };

        if (cupomInput) {
            const isNumericId = /^\d{17,20}$/.test(cupomInput);
            if (isNumericId) {
                if (cupomInput === userId) {
                    await interaction.editReply({ content: '❌ Você não pode indicar a si mesmo.' });
                    return;
                }
                const referrerMember = await guild.members.fetch(cupomInput).catch(() => null);
                if (!referrerMember) {
                    await interaction.editReply({ content: '❌ O ID de indicação fornecido não corresponde a um usuário válido neste servidor.' });
                    return;
                }
                const referrerDoc = await registeredUsers.findOne({ userId: cupomInput });
                if (!referrerDoc || !referrerDoc.paymentHistory || referrerDoc.paymentHistory.length === 0) {
                    await interaction.editReply({ content: '❌ Este ID de indicação não é válido, pois o usuário ainda não é um assinante.' });
                    return;
                }
                const currentUserDoc = await registeredUsers.findOne({ userId: userId });
                if (currentUserDoc && currentUserDoc.paymentHistory && currentUserDoc.paymentHistory.length > 0) {
                    await interaction.editReply({ content: '❌ Você não pode ser indicado, pois já é um assinante.' });
                    return; // Impede o registro e o log
                }
                // VERIFICAÇÃO-CHAVE: Impede o registro duplicado.
                const existingUser = await registeredUsers.findOne({ userId: userId });
                if (existingUser && existingUser.referredBy) {
                    const originalReferrer = await client.users.fetch(existingUser.referredBy).catch(() => null);
                    const referrerTag = originalReferrer ? `<@${originalReferrer.id}>` : `o usuário com ID \`${existingUser.referredBy}\``;
                    await interaction.editReply({ content: `❌ Você já foi indicado por ${referrerTag}. Não é possível alterar a indicação.` });
                    return; // Para a execução, não salva e não gera log.
                }
                isIndicationId = true;
                console.log(`[Indicação] Usuário ${userId} indicou o ID válido: ${cupomInput}`);
            } else {
                // Lógica antiga para cupons de texto
                const cupomUpper = cupomInput.toUpperCase();
                if (cupomUpper === 'CUPOM') {
                    // (Sua lógica para o cupom 'CUPOM' continua a mesma)
                    const couponUsed = await couponUsage.findOne({ userId, coupon: 'CUPOM' });
                    if (couponUsed) {
                        await interaction.editReply({ content: '❌ Você já utilizou o cupom CUPOM anteriormente.' });
                        return;
                    }
                    const now = new Date();
                    let expirationDate;
                    const existingExpiration = await expirationDates.findOne({ userId });
                    if (existingExpiration && new Date(existingExpiration.expirationDate) > now) {
                        expirationDate = new Date(existingExpiration.expirationDate);
                    } else {
                        expirationDate = new Date(now);
                    }
                    expirationDate.setDate(expirationDate.getDate() + 2);
                    await expirationDates.updateOne({ userId }, { $set: { expirationDate: expirationDate, createdAt: now } }, { upsert: true });
                    await couponUsage.insertOne({ userId, coupon: 'CUPOM', usedAt: now });
                    await logCouponUsage('CUPOM', '🎟️ Cupom de VIP Direto Utilizado', 'Um usuário ativou VIP por 2 dias com um cupom.');
                    await interaction.editReply({ content: `✅ Cupom CUPOM aplicado com sucesso! Sua assinatura foi estendida por 2 dias.` });
                    return;
                } else if (newIndicationCoupons.includes(cupomUpper)) {
                    await registeredUsers.updateOne({ userId }, { $set: { indication: cupomUpper } });
                    await couponUsage.insertOne({ userId, coupon: cupomUpper, usedAt: new Date() });
                    await logCouponUsage(cupomUpper, '🎟️ Cupom de Indicação (Texto) Aplicado', 'Um usuário utilizou um cupom de indicação em texto.');
                    // Adicionamos a resposta ao usuário e o 'return' para parar a execução
                    await interaction.editReply({ content: `✅ Cupom de indicação "${cupomUpper}" registrado com sucesso! Agora, para ativar sua assinatura, use o painel novamente e informe o valor do plano.` });
                    return;
                } else {
                    await interaction.editReply({ content: '❌ Cupom ou ID de Indicação inválido.' });
                    return;
                }
            }
        }
        if (!valorInputStr && isIndicationId) {
            await registeredUsers.updateOne({ userId }, { $set: { referredBy: cupomInput } });
            await logCouponUsage(cupomInput, '🎟️ ID de Indicação Registrado', `O usuário ${member.user.username} registrou ter sido indicado por ${cupomInput}.`);
            await interaction.editReply({ content: `✅ Entendido! Registramos que você foi indicado por <@${cupomInput}>. Agora, para ativar sua assinatura, use o painel novamente e informe o valor do plano.` });
            return;
        }

        const valorInput = parseFloat(valorInputStr);
        if (isNaN(valorInput) || valorInput <= 0) {
            await interaction.editReply({ content: '❌ Por favor, insira um valor numérico válido e positivo.' });
            return;
        }

        const planoTrimestral = 1200;
        const planoMensal = 500;
        const planoSemanal = 200;
        
        let valorFinalAPagar = 0;
        let saldoUtilizado = 0;
        let duration = 0;
        
        const balanceDoc = await userBalances.findOne({ userId });
        const saldoDisponivel = balanceDoc ? balanceDoc.balance : 0;

        const valorTrimestralComDesconto = Math.max(1, planoTrimestral - saldoDisponivel);
        const valorMensalComDesconto = Math.max(1, planoMensal - saldoDisponivel);
        const valorSemanalComDesconto = Math.max(1, planoSemanal - saldoDisponivel);

        if (saldoDisponivel > 0 && valorInput === valorTrimestralComDesconto) {
            valorFinalAPagar = valorTrimestralComDesconto;
            saldoUtilizado = planoTrimestral - valorFinalAPagar;
            duration = 90;
        } else if (saldoDisponivel > 0 && valorInput === valorMensalComDesconto) {
            valorFinalAPagar = valorMensalComDesconto;
            saldoUtilizado = planoMensal - valorFinalAPagar;
            duration = 30;
        } else if (saldoDisponivel > 0 && valorInput === valorSemanalComDesconto) {
            valorFinalAPagar = valorSemanalComDesconto;
            saldoUtilizado = planoSemanal - valorFinalAPagar;
            duration = 7;
        } else if (valorInput === planoTrimestral) {
            valorFinalAPagar = planoTrimestral;
            duration = 90;
        } else if (valorInput === planoMensal) {
            valorFinalAPagar = planoMensal;
            duration = 30;
        } else if (valorInput === planoSemanal) {
            valorFinalAPagar = planoSemanal;
            duration = 7;
        } else {
            let errorMessage = `❌ Valor inválido de R$ ${valorInput.toFixed(2)}.\n\n` +
                               `**Opções de Assinatura:**\n` +
                               `- **R$ ${planoSemanal.toFixed(2)}** (VIP Semanal)\n` +
                               `- **R$ ${planoMensal.toFixed(2)}** (VIP Mensal)\n` +
                               `- **R$ ${planoTrimestral.toFixed(2)}** (VIP Trimestral)`;

            if (saldoDisponivel > 0) {
                errorMessage += `\n\n**Com seu saldo, você também pode pagar:**\n` +
                                `- **R$ ${valorSemanalComDesconto.toFixed(2)}** (VIP Semanal com desconto)\n` +
                                `- **R$ ${valorMensalComDesconto.toFixed(2)}** (VIP Mensal com desconto)\n` +
                                `- **R$ ${valorTrimestralComDesconto.toFixed(2)}** (VIP Trimestral com desconto)`;
            }
            
            await interaction.editReply({ content: errorMessage });
            return;
        }
        // --- FIM DA LÓGICA DE VALIDAÇÃO DE VALOR ---
        
        console.log('[Debug] 6. Validação de valor concluída. Editando resposta para "Gerando pagamento"...');
        await interaction.editReply({ content: '⏳ Gerando seu pagamento, por favor aguarde...' });
        console.log('[Debug] 7. Resposta editada. Iniciando criação do canal de pagamento...');
        
        if (isIndicationId) {
            await registeredUsers.updateOne({ userId }, { $set: { referredBy: cupomInput } });
            await logCouponUsage(cupomInput, '🎟️ ID de Indicação Aplicado com Pagamento', `O usuário ${member.user.username} iniciou um pagamento e informou ter sido indicado por ${cupomInput}.`);
        }
        
        let target; 
        let paymentChannel; 
        try {
            const botMember = await guild.members.fetch(client.user.id);
            const category = await guild.channels.fetch(CATEGORIA_PAGAMENTOS_ID);
            if (!category || category.type !== ChannelType.GuildCategory) throw new Error(`Categoria de pagamentos (ID: ${CATEGORIA_PAGAMENTOS_ID}) não encontrada.`);
            
            const botPermissions = category.permissionsFor(botMember);
            if (!botPermissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('O bot não tem permissão para criar canais na categoria.');
            
            const createChannelPromise = guild.channels.create({
                name: `pix-${interaction.user.username.replace(/[^a-zA-Z0-9-]/g, '').substring(0, 20)}`,
                type: ChannelType.GuildText,
                parent: CATEGORIA_PAGAMENTOS_ID,
                permissionOverwrites: [
                    { id: guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: userId, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                    { id: client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ManageChannels] },
                ],
            });
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout de 20s atingido.')), 20000));
            
            paymentChannel = await Promise.race([createChannelPromise, timeoutPromise]);
            target = paymentChannel;
            
            await activePixChannels.updateOne({ userId: userId }, { $set: { channelId: paymentChannel.id, createdAt: new Date() } }, { upsert: true });
            await interaction.editReply({ content: `✅ Seu canal de pagamento foi criado: ${paymentChannel}` });

        } catch (channelError) {
            console.warn(`[AVISO] Falha ao criar canal de pagamento (${channelError.message}). Ativando fallback para DM.`);
            target = interaction.user; 
            await interaction.editReply({ content: '⚠️ A criação do canal falhou. Tentando enviar as informações por Mensagem Direta (DM)...' });
        }

        try {
            // A chamada agora usa as variáveis validadas
            console.log('[Debug] 8. Canal de pagamento definido. Chamando a API do PagBank...');
            const paymentInfo = await createPagBankPayment(userId, valorFinalAPagar, duration, saldoUtilizado, userDoc.name, userDoc.whatsapp);
            console.log('[Debug] 9. Resposta da API do PagBank recebida com sucesso.');
            
            const qrCodeBuffer = Buffer.from(paymentInfo.qrCodeBase64, 'base64');
            const attachment = new AttachmentBuilder(qrCodeBuffer, { name: 'qrcode.png' });
            const embedPagamento = new EmbedBuilder()
                .setTitle('💳 Pagamento PIX Automatizado')
                .setDescription('Sua fatura foi gerada! Pague usando o QR Code ou o código abaixo.\n\n✅ **Sua assinatura será ativada automaticamente.**')
                .addFields(
                    { name: '💰 Valor', value: `R$${valorFinalAPagar.toFixed(2)}`, inline: true },
                    { name: '🕒 Validade da Fatura', value: '10 minutos', inline: true },
                    { name: '📝 Código PIX (Copia e Cola)', value: `\`\`\`${paymentInfo.copiaECola}\`\`\`` }
                ).setImage('attachment://qrcode.png').setColor('#00FF99').setFooter({ text: 'Não é necessário enviar comprovante.' });
            
            const rowPagamento = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('copiar_pix').setLabel('Copiar Código PIX').setStyle(ButtonStyle.Secondary).setEmoji('📋'));
        
            await target.send({ content: `<@${userId}>, seu pagamento foi gerado!`, embeds: [embedPagamento], files: [attachment], components: [rowPagamento] });

            if (target !== interaction.user && paymentChannel) {
                setTimeout(async () => {
                    try {
                        if (guild.channels.cache.has(paymentChannel.id)) {
                            await paymentChannel.delete('Tempo de pagamento expirado.');
                        }
                    } catch(err) { console.error(`Erro ao deletar o canal ${paymentChannel.name}:`, err); }
                    await activePixChannels.deleteOne({ userId: userId });
                }, 10 * 60 * 1000); 
            } else if (target === interaction.user) {
                // Se o alvo for DM, a resposta inicial já foi editada, podemos só confirmar.
                // Opcional: pode-se usar followUp se a resposta inicial precisar ser mantida.
            }

        } catch (err) { 
            console.error('Erro ao gerar pagamento ou enviar mensagem (principal/fallback):', err);
            let finalErrorMessage = '❌ Ocorreu um erro grave ao gerar seu pagamento. Contate o suporte.';
            if (err.code === 50007) { 
                finalErrorMessage = '❌ Falha ao enviar DM. Verifique se suas Mensagens Diretas estão abertas para este servidor e tente novamente.'
            }
            await interaction.editReply({ content: finalErrorMessage });
        }

    } catch (err) {
        console.error('Erro geral no handler formulario_saldo:', err);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.editReply({ content: '❌ Ocorreu um erro inesperado.' }).catch(() => {});
        }
    }
}
// Botão de copiar PIX
if (interaction.isButton() && interaction.customId === 'copiar_pix') {
    try {
        const originalMessage = interaction.message;
        if (!originalMessage || !originalMessage.embeds || originalMessage.embeds.length === 0) {
            return await interaction.reply({
                content: '❌ Não foi possível encontrar a mensagem original com o código PIX.',
            });
        }

        const embed = originalMessage.embeds[0];
        const pixField = embed.fields.find(field => field.name.includes('Código PIX'));
        
        if (!pixField || !pixField.value) {
            return await interaction.reply({
                content: '❌ Não foi possível extrair o código PIX da mensagem.',
            });
        }

        // Remove os ``` do início e do fim do código
        const pixCode = pixField.value.replace(/```/g, '').trim();

        // Responde de forma efêmera (só o usuário vê) com o código para facilitar a cópia
        await interaction.reply({
            content: pixCode,
            flags: [MessageFlags.Ephemeral]
        });

    } catch (err) {
        console.error('Erro ao processar o botão copiar_pix:', err);
        try {
            await interaction.reply({
                content: '❌ Ocorreu um erro ao tentar copiar o código PIX.',
            });
        } catch (replyErr) {
            console.error('Erro ao responder interação de copiar_pix:', replyErr);
        }
    }
}

    // Botão consultar saldo
    if (interaction.isButton() && interaction.customId === 'consultar_saldo') {
        try {
            const userId = interaction.user.id;
            const userDoc = await registeredUsers.findOne({ userId });
            if (!userDoc) {
                await interaction.reply({
                    content: '❌ Você precisa se registrar antes de fazer uma consulta. Vá para #registrar-se.',
                    flags: [MessageFlags.Ephemeral]
                });
                return;
            }
    
            // --- NOVA LÓGICA ---
            // Buscar o saldo de bônus
            const balanceDoc = await userBalances.findOne({ userId });
            const bonusBalance = balanceDoc ? balanceDoc.balance : 0;
    
            // Buscar a data de expiração
            const expirationRecord = await expirationDates.findOne({ userId });

            let lastPaymentInfo = 'Nenhum pagamento registrado';
            // Verifica se o histórico de pagamentos existe e não está vazio
            if (userDoc.paymentHistory && userDoc.paymentHistory.length > 0) {
                // Pega o último item do array
                const lastPayment = userDoc.paymentHistory[userDoc.paymentHistory.length - 1];
                // Formata a data e o valor
                const paymentDate = new Date(lastPayment.timestamp).toLocaleDateString('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    year: 'numeric'
                });
                const paymentAmount = Number(lastPayment.amount).toFixed(2);
                lastPaymentInfo = `R$ ${paymentAmount} em ${paymentDate}`;
            }
            
            const embed = new EmbedBuilder()
                .setTitle('🔍 Consulta de Conta')
                .setColor('#00BFFF')
                .setAuthor({ name: interaction.user.username, iconURL: interaction.user.displayAvatarURL() });
    
            // Adiciona o campo de Saldo de Bônus
            embed.addFields({ name: '💰 Saldo de Bônus', value: `**R$ ${bonusBalance.toFixed(2)}**` });
            embed.addFields({ name: '💳 Último Pagamento', value: lastPaymentInfo });

            // Adiciona informações da assinatura, se existir
            if (expirationRecord && expirationRecord.expirationDate) {
                const now = new Date();
                const daysLeft = calculateDaysLeft(expirationRecord.expirationDate, now);
                const daysMessage = daysLeft > 0 ? `${daysLeft} dias restantes` : 'Expirada';
                
                embed.addFields(
                    { name: '✅ Status da Assinatura', value: 'Ativa', inline: true },
                    { name: '🗓️ Expira em', value: daysMessage, inline: true }
                );
            } else {
                embed.addFields({ name: '❌ Status da Assinatura', value: 'Inativa' });
                embed.setDescription('Você não possui uma assinatura VIP ativa no momento.');
            }
    
            await interaction.reply({
                embeds: [embed],
                flags: [MessageFlags.Ephemeral]
            });
    
        } catch (err) {
            console.error('Erro ao consultar saldo:', err);
            try {
                await interaction.reply({
                    content: '❌ Ocorreu um erro ao realizar a consulta.',
                    flags: [MessageFlags.Ephemeral]
                });
            } catch (replyErr) {
                console.error('Erro ao responder interação de consultar saldo:', replyErr);
            }
        }
    }
    });

const PORT = process.env.PORT || 8080;
app.listen(PORT, async () => {
    console.log(`[API] Servidor rodando na porta ${PORT}`);
    try {
        await initializeCollections();
        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        console.error("Erro fatal durante a inicialização:", error);
        process.exit(1);
    }
});