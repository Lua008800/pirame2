// Ficheiro: functions/index.js

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const mercadopago = require("mercadopago");

admin.initializeApp();

// Configure o Mercado Pago com o SEU TOKEN SECRETO
// NUNCA partilhe este token!
const MP_ACCESS_TOKEN = "SEU_ACCESS_TOKEN_AQUI"; // Use o seu token de PRODUÇÃO

mercadopago.configure({
  access_token: MP_ACCESS_TOKEN,
});

/**
 * Cria uma preferência de pagamento no Mercado Pago.
 * Esta função é chamada a partir do seu index.html.
 */
exports.createPaymentPreference = functions.https.onCall(async (data, context) => {
  // Verifica se o utilizador está logado
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "O utilizador deve estar logado para pagar."
    );
  }

  const userId = context.auth.uid;
  const userEmail = context.auth.token.email;
  const amount = Number(data.amount);

  if (isNaN(amount) || amount < 40) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "O valor do depósito é inválido."
    );
  }

  // Objeto da preferência de pagamento
  const preference = {
    items: [
      {
        title: "Depósito na Plataforma Itambe",
        description: `Carga de saldo para o utilizador: ${userEmail}`,
        quantity: 1,
        currency_id: "BRL",
        unit_price: amount,
      },
    ],
    payer: {
      email: userEmail,
    },
    back_urls: {
      // URL para onde o utilizador volta após pagar
      success: "https://itambe1.firebaseapp.com", // Mude para o seu URL
      failure: "https://itambe1.firebaseapp.com", // Mude para o seu URL
      pending: "https://itambe1.firebaseapp.com", // Mude para o seu URL
    },
    auto_return: "approved",
    metadata: {
      // Metadados para sabermos quem pagou
      firebase_user_id: userId,
    },
    // Notificação para o seu sistema (Webhook) - Essencial para atualizar o saldo
    notification_url: "https://SUA_URL_DE_WEBHOOK_AQUI", // (Isto é um passo avançado)
  };

  try {
    const response = await mercadopago.preferences.create(preference);
    
    // Retorna o link de pagamento para o frontend
    const initPoint = response.body.init_point;
    return { init_point: initPoint };

  } catch (error) {
    console.error("Erro ao criar preferência no Mercado Pago:", error);
    throw new functions.https.HttpsError(
      "internal",
      "Não foi possível criar o pagamento."
    );
  }
});