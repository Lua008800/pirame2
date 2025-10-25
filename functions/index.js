/**
 * Importar as dependências necessárias do Firebase e do Mercado Pago.
 */
const functions = require("firebase-functions");
const admin = require("firebase-admin");
const mercadopago = require("mercadopago");

// Inicializar a aplicação de administração do Firebase.
admin.initializeApp();
const db = admin.firestore();

// ATUALIZAÇÃO: O Access Token será agora acedido através de 'process.env'
// graças à integração com o Secret Manager.
mercadopago.configure({
  access_token: process.env.MERCADOPAGO_TOKEN,
});

/**
 * Cloud Function #1: Criar uma Ordem de Pagamento PIX para Depósito.
 *
 * ATUALIZAÇÃO: A função agora especifica que precisa de aceder ao segredo 'MERCADOPAGO_TOKEN'.
 */
exports.createDepositOrder = functions.runWith({ secrets: ["MERCADOPAGO_TOKEN"] }).https.onCall(async (data, context) => {
  // Verificar se o utilizador está autenticado.
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "É necessário estar autenticado para criar um depósito.",
    );
  }

  const amount = data.amount;
  const userId = context.auth.uid;

  // Validar o valor.
  if (!amount || amount < 40 || amount > 5000) {
    throw new functions.https.HttpsError(
        "invalid-argument",
        "O valor do depósito é inválido.",
    );
  }
  
  const region = process.env.FUNCTION_REGION || 'us-central1'; // Adiciona um fallback
  const projectId = process.env.GCLOUD_PROJECT;
  const notification_url = `https://${region}-${projectId}.cloudfunctions.net/paymentWebhook`;

  const paymentData = {
    transaction_amount: amount,
    description: `Depósito Itambe - Utilizador: ${userId}`,
    payment_method_id: "pix",
    payer: {
      email: `${userId}@itambe.com`, // Email de exemplo
    },
    external_reference: userId,
    notification_url: notification_url, 
  };

  try {
    const result = await mercadopago.payment.create(paymentData);
    const pixData = result.body.point_of_interaction.transaction_data;
    return {
      qr_code_base64: pixData.qr_code_base64,
      qr_code: pixData.qr_code,
    };
  } catch (error) {
    console.error("Erro ao criar pagamento no Mercado Pago:", error);
    throw new functions.https.HttpsError(
        "internal",
        "Não foi possível gerar o PIX. Tente novamente.",
    );
  }
});

/**
 * Cloud Function #2: Webhook para Confirmação de Pagamento.
 * ATENÇÃO: Esta função requer um URL público para ser configurada no Mercado Pago.
 * A implementação no Firebase Functions gera este URL automaticamente.
 *
 * Acionador: Chamada pelo Mercado Pago quando um pagamento é aprovado.
 *
 * Lógica:
 * 1. Recebe a notificação do Mercado Pago.
 * 2. Obtém os detalhes completos do pagamento usando o ID da notificação.
 * 3. Verifica se o pagamento foi aprovado ("approved").
 * 4. Obtém o ID do utilizador a partir do `external_reference`.
 * 5. Adiciona o valor do depósito (mais o bónus, se aplicável) ao saldo do utilizador.
 */
exports.paymentWebhook = functions.https.onRequest(async (req, res) => {
    const paymentId = req.query.id;

    if (req.query.topic !== "payment") {
        res.status(200).send("Not a payment topic");
        return;
    }

    try {
        const payment = await mercadopago.payment.get(paymentId);
        const paymentStatus = payment.body.status;
        const externalReference = payment.body.external_reference;
        const amount = payment.body.transaction_amount;

        if (paymentStatus === "approved") {
            const userRef = db.collection("users").doc(externalReference);
            const userDoc = await userRef.get();

            if (userDoc.exists) {
                const userData = userDoc.data();
                let bonus = 0;
                // Aplica o bónus apenas se for o primeiro depósito e o valor for elegível.
                if (!userData.hasDeposited && amount >= 200) {
                    bonus = amount * 0.5; // 50% de bónus
                }
                const totalAmount = amount + bonus;

                // Atualiza o saldo e marca que o utilizador já depositou.
                await userRef.update({
                    balance: admin.firestore.FieldValue.increment(totalAmount),
                    hasDeposited: true,
                });

                console.log(`Saldo de ${totalAmount} (incluindo ${bonus} de bónus) adicionado ao utilizador ${externalReference}.`);
            }
        }
        res.status(200).send("OK");
    } catch (error) {
        console.error("Erro no webhook do Mercado Pago:", error);
        res.status(500).send("Erro ao processar o webhook.");
    }
});


/**
 * Cloud Function #3: Processar um Pedido de Levantamento.
 *
 * Acionador: Chamada diretamente pelo front-end (Callable Function).
 *
 * Lógica:
 * 1. Recebe o valor do levantamento do front-end.
 * 2. Verifica se o utilizador tem saldo suficiente.
 * 3. Se tiver saldo, debita o valor da conta.
 * 4. **[Ação Futura]** Chama a API de Payouts do Mercado Pago para transferir o dinheiro.
 * (Esta parte requer aprovação da API de Payouts do Mercado Pago).
 */
exports.processWithdrawal = functions.runWith({ secrets: ["MERCADOPAGO_TOKEN"] }).https.onCall(async (data, context) => { // Adicionado runWith secrets
  if (!context.auth) {
    throw new functions.https.HttpsError(
        "unauthenticated",
        "É necessário estar autenticado.",
    );
  }

  const amount = data.amount;
  const userId = context.auth.uid;

  if (!amount || amount < 30 || amount > 5000) {
    throw new functions.https.HttpsError(
        "invalid-argument", "Valor de levantamento inválido.",
    );
  }

  const userRef = db.collection("users").doc(userId);
  const userDoc = await userRef.get();
  
  if (!userDoc.exists) {
     throw new functions.https.HttpsError(
        "not-found", "Utilizador não encontrado.",
    );
  }

  const currentBalance = userDoc.data().balance || 0;
  const pixKey = userDoc.data().pixKey;
  const pixFullName = userDoc.data().pixFullName;

  if (!pixKey || !pixFullName) {
    throw new functions.https.HttpsError(
        "failed-precondition", "Dados PIX incompletos. Registe o nome completo e a chave PIX no seu perfil.",
    );
  }

  if (currentBalance < amount) {
    throw new functions.https.HttpsError(
        "failed-precondition", "Saldo insuficiente.",
    );
  }

  // Debitar o saldo primeiro
  await userRef.update({
    balance: admin.firestore.FieldValue.increment(-amount),
  });

  // AQUI ENTRARIA A LÓGICA PARA CHAMAR A API DE PAYOUTS DO MERCADO PAGO
  console.log(`Iniciando transferência PIX de R$${amount} para a chave ${pixKey} (${pixFullName}) do utilizador ${userId}`);
  // Exemplo de como poderia ser (requer a biblioteca e configuração de Payouts):
  // try {
  //   const payoutResult = await mercadopago.payout.create({
  //      transaction_amount: amount,
  //      description: `Levantamento Itambe - Utilizador ${userId}`,
  //      external_reference: `WD-${userId}-${Date.now()}`,
  //      payment_method_id: 'pix',
  //      notification_url: `URL_DO_SEU_WEBHOOK_DE_PAYOUTS`,
  //      receiver_address: { // Detalhes fictícios, a API de Payouts tem estrutura própria
  //         pix_key_type: 'DETECTAR_TIPO_DA_CHAVE', // Ex: CPF, CNPJ, EMAIL, PHONE, EVP
  //         pix_key: pixKey,
  //         receiver_name: pixFullName
  //      }
  //   });
  //   console.log("Payout criado com sucesso:", payoutResult.body.id);
  //   return {success: true, message: "Pedido de levantamento processado e enviado para transferência!"};
  // } catch(payoutError) {
  //   console.error("Erro ao criar payout:", payoutError);
  //   // Reverter o débito do saldo se o payout falhar
  //   await userRef.update({ balance: admin.firestore.FieldValue.increment(amount) });
  //   throw new functions.https.HttpsError( "internal", "Falha ao iniciar a transferência PIX. O saldo foi revertido.");
  // }
  
  // Como a API de Payouts não está integrada, retornamos sucesso após debitar
  return {success: true, message: "Pedido de levantamento processado! (Transferência PIX simulada)"}; 
});


/**
 * Cloud Function #4: Distribuir Comissões de Afiliação.
 * ... (código existente inalterado) ...
 */
exports.distributeCommissions = functions.firestore
    .document("users/{userId}/affiliatedProducts/{productId}")
    .onCreate(async (snap, context) => {
      const {userId} = context.params;
      const affiliatedProduct = snap.data();

      // 1. Obter o preço do produto original.
      const productRef = db.collection("products")
          .doc(affiliatedProduct.productId);
      const productDoc = await productRef.get();

      if (!productDoc.exists) {
        console.log(`Produto ${affiliatedProduct.productId} não encontrado.`);
        return null;
      }
      const productPrice = productDoc.data().price;

      // 2. Obter os dados do utilizador que se afiliou para encontrar o referenciador.
      const userRef = db.collection("users").doc(userId);
      const userDoc = await userRef.get();
      if (!userDoc.exists) {
        console.log(`Utilizador ${userId} não encontrado.`);
        return null;
      }

      const referrerId = userDoc.data().referredBy;

      // 3. Se não houver referenciador (nível 1), termina a execução.
      if (!referrerId) {
        console.log(`Utilizador ${userId} não tem referenciador.`);
        return null;
      }

      // --- Processar Comissão Nível 1 ---
      try {
        const referrerRef = db.collection("users").doc(referrerId);
        const commissionL1 = productPrice * 0.20;

        await referrerRef.update({
          balance: admin.firestore.FieldValue.increment(commissionL1),
          earningsLevel1: admin.firestore.FieldValue.increment(commissionL1),
        });
        console.log(`Pagos ${commissionL1} de comissão Nível 1 a ${referrerId}.`);

        // --- Processar Comissão Nível 2 ---
        const referrerDoc = await referrerRef.get();
        if (!referrerDoc.exists) {
          return null; // Termina se o referenciador de nível 1 não existir.
        }

        const grandReferrerId = referrerDoc.data().referredBy;
        if (!grandReferrerId) {
          console.log(`Referenciador ${referrerId} não tem referenciador (Nível 2).`);
          return null;
        }

        const grandReferrerRef = db.collection("users").doc(grandReferrerId);
        const commissionL2 = productPrice * 0.05;

        await grandReferrerRef.update({
          balance: admin.firestore.FieldValue.increment(commissionL2),
          earningsLevel2: admin.firestore.FieldValue.increment(commissionL2),
        });
        console.log(`Pagos ${commissionL2} de comissão Nível 2 a ${grandReferrerId}.`);
      } catch (error) {
        console.error("Erro ao processar comissões:", error);
      }

      return null;
    });


/**
 * ATENÇÃO: A função abaixo foi comentada porque requer o plano Blaze (pago) do Firebase.
 * Quando fizer o upgrade do seu projeto, pode remover os comentários (/ * e * /)
 * e implementar novamente para ativar os rendimentos diários automáticos.
 *
 * Cloud Function #5: Distribuir Rendimentos Diários.
 * ... (código existente inalterado) ...
 */
/*
exports.distributeDailyYields = functions.pubsub.schedule("0 0 * * *")
    .timeZone("America/Sao_Paulo") // Fuso horário de São Paulo
    .onRun(async (context) => {
      console.log("A iniciar a distribuição de rendimentos diários...");

      const usersSnapshot = await db.collection("users").get();

      if (usersSnapshot.empty) {
        console.log("Nenhum utilizador encontrado.");
        return null;
      }

      const promises = [];
      usersSnapshot.forEach((userDoc) => {
        const userId = userDoc.id;
        const userRef = userDoc.ref;
        const affiliatedProductsRef = userRef.collection("affiliatedProducts");

        const processUser = async () => {
          const productsSnapshot = await affiliatedProductsRef.get();

          if (productsSnapshot.empty) {
            return;
          }

          let totalYield = 0;
          const today = new Date();

          productsSnapshot.forEach((prodDoc) => {
            const product = prodDoc.data();
            const affiliatedDate = product.affiliatedAt.toDate();
            const daysPassed = (today - affiliatedDate) / (1000 * 60 * 60 * 24);

            if (daysPassed <= product.cycleDays) {
              totalYield += product.dailyReturn;
            }
          });

          if (totalYield > 0) {
            console.log(`A adicionar ${totalYield} ao saldo do utilizador ${userId}.`);
            await userRef.update({
              balance: admin.firestore.FieldValue.increment(totalYield),
            });
          }
        };
        promises.push(processUser());
      });

      await Promise.all(promises);
      console.log("Distribuição de rendimentos diários concluída.");
      return null;
    });
*/

