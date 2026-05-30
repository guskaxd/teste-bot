const { Client: WhatsAppClient, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
require('dotenv').config(); // Para ler o MEU_WHATSAPP do .env

// Essa função recebe as coleções do MongoDB lá do index.js
function iniciarWhatsApp(registeredUsers, expirationDates) {
    console.log('[WhatsApp] Inicializando cliente...');

    const whatsappClient = new WhatsAppClient({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: '/usr/bin/chromium', // Diz pro bot usar o navegador do Railway
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage' // Evita que o bot trave por falta de memória RAM
            ]
        }
    });

    whatsappClient.on('qr', (qr) => {
        console.log('\n=============================================================');
        console.log('📱 ESCANEIE O QR CODE ABAIXO NO SEU WHATSAPP (Aparelhos Conectados)');
        console.log('=============================================================\n');
        qrcode.generate(qr, { small: true });
    });

    whatsappClient.on('ready', () => {
        console.log('[WhatsApp] ✅ Conectado com sucesso ao seu próprio número!');
        
        // Manda a lista 15 segundos após conectar no WhatsApp
        setTimeout(() => {
            enviarRelatorioCompletoZap();
        }, 15000);
    });

    whatsappClient.on('auth_failure', msg => {
        console.error('[WhatsApp] ❌ Falha na autenticação', msg);
    });

    // Função de envio embutida para ter acesso ao whatsappClient e ao banco
    async function enviarRelatorioCompletoZap() {
        try {
            console.log('[WhatsApp] Levantando histórico completo de inativos...');
            const todosUsuarios = await registeredUsers.find({}).toArray();
            let telefonesInativos = [];

            for (const user of todosUsuarios) {
                const exp = await expirationDates.findOne({ userId: user.userId });
                const now = new Date();

                if ((!exp || new Date(exp.expirationDate) <= now) && user.whatsapp) {
                    telefonesInativos.push(user.whatsapp);
                }
            }

            if (telefonesInativos.length > 0) {
                const listaFormatada = telefonesInativos.map(num => `• ${num}`).join('\n');
                const textoMsg = `🔴 *LIMPA GERAL (Histórico Completo)*\nTotal de inativos no banco: ${telefonesInativos.length}\n\n${listaFormatada}`;
                
                const myPhone = process.env.MEU_WHATSAPP;
                
                if (myPhone) {
                    const chatId = `${myPhone}@c.us`; 
                    await whatsappClient.sendMessage(chatId, textoMsg);
                    console.log(`[WhatsApp] Relatório completo enviado com sucesso direto pro seu Zap!`);
                } else {
                    console.warn('[WhatsApp] Erro: Variável MEU_WHATSAPP não está configurada.');
                }
            } else {
                 console.log('[WhatsApp] Nenhum inativo encontrado no banco. Todos estão em dia!');
            }
        } catch (err) {
            console.error('[WhatsApp] Erro ao enviar relatório completo:', err);
        }
    }

    // Dá a partida no bot
    whatsappClient.initialize();
}

// Exporta a função para o index.js poder usar
module.exports = { iniciarWhatsApp };