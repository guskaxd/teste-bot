const { Client: WhatsAppClient, LocalAuth } = require('whatsapp-web.js');
require('dotenv').config();

function iniciarWhatsApp(registeredUsers, expirationDates) {
    console.log('[WhatsApp] Inicializando cliente com otimização de memória...');

    const whatsappClient = new WhatsAppClient({
        authStrategy: new LocalAuth(),
        puppeteer: {
            // Trava o Chrome para consumir o MÍNIMO de memória possível
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ]
        }
    });

    let qrCount = 0; // Contador para você saber qual tentativa é
    
    whatsappClient.on('qr', (qr) => {
        qrCount++;
        const agora = new Date().toLocaleTimeString('pt-BR'); // Pega a hora exata
        
        console.log('\n=============================================================');
        console.log(`⏳ [${agora}] TENTATIVA ${qrCount} - NOVO QR CODE GERADO!`);
        console.log('⚠️ ATENÇÃO: Você tem apenas 15 segundos para escanear este link:');
        console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
        console.log('=============================================================\n');
    });

    // Rastreador 1: Avisa assim que o celular aprovar o QR Code
    whatsappClient.on('authenticated', () => {
        console.log('[WhatsApp] 🔐 Autenticado com sucesso! Sincronizando mensagens...');
    });

    // Rastreador 2: Mostra a porcentagem de carregamento
    whatsappClient.on('loading_screen', (percent, message) => {
        console.log(`[WhatsApp] ⏳ Carregando... ${percent}% - ${message}`);
    });

    whatsappClient.on('ready', async () => {
        console.log('[WhatsApp] ✅ Conectado com sucesso ao seu próprio número!');
        
        const myPhone = process.env.MEU_WHATSAPP;
        if (myPhone) {
            try {
                const chatIdValidado = await whatsappClient.getNumberId(myPhone); 
                if (chatIdValidado) {
                    await whatsappClient.sendMessage(chatIdValidado._serialized, "🤖 *Bot conectado com sucesso!* Levantando inativos em 15 segundos...");
                }
            } catch (err) {
                 console.log('[WhatsApp] Erro ao enviar mensagem de teste.', err);
            }
        }

        setTimeout(() => {
            enviarRelatorioCompletoZap();
        }, 15000);
    });

    // Rastreador 3: Avisa se for desconectado
    whatsappClient.on('disconnected', (reason) => {
        console.log('[WhatsApp] 🔌 Desconectado! Motivo:', reason);
    });

    whatsappClient.on('auth_failure', msg => {
        console.error('[WhatsApp] ❌ Falha na autenticação', msg);
    });

    async function enviarRelatorioCompletoZap() {
        try {
            console.log('[WhatsApp] Levantando histórico completo de inativos...');
            const todosUsuarios = await registeredUsers.find({}).toArray();
            let listaInativos = [];

            for (const user of todosUsuarios) {
                const exp = await expirationDates.findOne({ userId: user.userId });
                const now = new Date();

                if ((!exp || new Date(exp.expirationDate) <= now) && user.whatsapp) {
                    const nome = user.name || 'Desconhecido';
                    listaInativos.push(`• ${nome} - ${user.whatsapp}`);
                }
            }

            if (listaInativos.length > 0) {
                const listaFormatada = listaInativos.join('\n');
                const textoMsg = `🔴 *LIMPA GERAL (Histórico Completo)*\nTotal de inativos no banco: ${listaInativos.length}\n\n${listaFormatada}`;
                
                const myPhone = process.env.MEU_WHATSAPP;
                
                if (myPhone) {
                    const chatIdValidado = await whatsappClient.getNumberId(myPhone); 
                    if (chatIdValidado) {
                        await whatsappClient.sendMessage(chatIdValidado._serialized, textoMsg);
                        console.log(`[WhatsApp] Relatório enviado!`);
                    }
                } 
            } else {
                 console.log('[WhatsApp] Nenhum inativo encontrado no banco. Todos estão em dia!');
            }
        } catch (err) {
            console.error('[WhatsApp] Erro ao enviar relatório completo:', err);
        }
    }

    whatsappClient.initialize();
}

module.exports = { iniciarWhatsApp };