const { Client: WhatsAppClient, LocalAuth } = require('whatsapp-web.js');
require('dotenv').config(); 

function iniciarWhatsApp(registeredUsers, expirationDates) {
    console.log('[WhatsApp] Inicializando cliente...');

    const whatsappClient = new WhatsAppClient({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    });

    whatsappClient.on('qr', (qr) => {
        console.log('\n=============================================================');
        console.log('📱 CLIQUE NO LINK ABAIXO PARA ABRIR O SEU QR CODE:');
        console.log(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
        console.log('=============================================================\n');
    });

    whatsappClient.on('ready', async () => {
        console.log('[WhatsApp] ✅ Conectado com sucesso ao seu próprio número!');
        
        // TESTE: Manda um "Oi" para você mesmo para confirmar que conectou!
        const myPhone = process.env.MEU_WHATSAPP;
        if (myPhone) {
            try {
                const chatIdValidado = await whatsappClient.getNumberId(myPhone); 
                if (chatIdValidado) {
                    await whatsappClient.sendMessage(chatIdValidado._serialized, "🤖 *Bot do WhatsApp conectado com sucesso!* Levantando inativos em 15 segundos...");
                }
            } catch (err) {
                 console.log('[WhatsApp] Erro ao enviar mensagem de teste.', err);
            }
        }

        // Manda a lista 15 segundos após conectar no WhatsApp
        setTimeout(() => {
            enviarRelatorioCompletoZap();
        }, 15000);
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
                    } else {
                        console.error(`[WhatsApp] ERRO: Número ${myPhone} inválido no WhatsApp.`);
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