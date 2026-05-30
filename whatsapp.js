const { Client: WhatsAppClient, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
require('dotenv').config(); // Para ler o MEU_WHATSAPP do .env

// Essa função recebe as coleções do MongoDB lá do index.js
function iniciarWhatsApp(registeredUsers, expirationDates) {
    console.log('[WhatsApp] Inicializando cliente...');

    const whatsappClient = new WhatsAppClient({
        authStrategy: new LocalAuth(),
        puppeteer: {
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage'
            ]
        }
    });

    whatsappClient.on('qr', (qr) => {
        console.log('\n=============================================================');
        console.log('📱 CLIQUE NO LINK ABAIXO PARA ABRIR O SEU QR CODE:');
        
        // Gera um link direto com a imagem perfeita do QR Code
        const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`;
        console.log(qrCodeUrl);
        
        console.log('=============================================================\n');
        
        // (Opcional) Mantém o do terminal caso queira tentar o truque do zoom
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
            let listaInativos = []; // Agora vai guardar nome e telefone

            for (const user of todosUsuarios) {
                const exp = await expirationDates.findOne({ userId: user.userId });
                const now = new Date();

                // Se não tem expiração OU a data já passou, e ele tem whatsapp salvo
                if ((!exp || new Date(exp.expirationDate) <= now) && user.whatsapp) {
                    // Pega o nome ou coloca "Desconhecido" caso não tenha no banco
                    const nome = user.name || 'Desconhecido';
                    listaInativos.push(`• ${nome} - ${user.whatsapp}`);
                }
            }

            if (listaInativos.length > 0) {
                const listaFormatada = listaInativos.join('\n');
                const textoMsg = `🔴 *LIMPA GERAL (Histórico Completo)*\nTotal de inativos no banco: ${listaInativos.length}\n\n${listaFormatada}`;
                
                const myPhone = process.env.MEU_WHATSAPP;
                
                if (myPhone) {
                    console.log(`[WhatsApp] Validando o número ${myPhone} com a API do WhatsApp...`);
                    
                    // MÁGICA: Pede pro próprio WhatsApp descobrir se o número tem o 9º dígito ou não
                    const chatIdValidado = await whatsappClient.getNumberId(myPhone); 
                    
                    if (chatIdValidado) {
                        // Usa a ID exata que o WhatsApp retornou (_serialized)
                        await whatsappClient.sendMessage(chatIdValidado._serialized, textoMsg);
                        console.log(`[WhatsApp] Relatório com ${listaInativos.length} inativos enviado com sucesso direto pro seu Zap!`);
                    } else {
                        console.error(`[WhatsApp] ERRO: O número ${myPhone} não está registrado no WhatsApp. Verifique se o DDD está correto e se tem o 55.`);
                    }
                } else {
                    console.warn('[WhatsApp] Erro: Variável MEU_WHATSAPP não está configurada no .env.');
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