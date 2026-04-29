// ================================================================
// DashBot Admin v3 — Endpoint de validação de produto para EAs
// Arquivo: routes/validateProduct.js
//
// COMO ADICIONAR AO SEU SERVER.JS:
//   const validateProduct = require('./routes/validateProduct');
//   app.use('/validate-product', validateProduct);
//
// COMO FUNCIONA:
//   O EA chama: GET /validate-product?account=123&product=prod_XXX&token=dashbot2024
//   O servidor verifica se:
//     1. O token é válido
//     2. O produto existe
//     3. A conta MT5 tem licença ativa para esse produto
//     4. A licença não expirou
//   E retorna as configurações personalizadas (minLots, maxLots, instances)
// ================================================================

const express = require('express');
const router  = express.Router();

// ── Ajuste este require para o seu módulo de banco de dados ──────
// Exemplos comuns:
//   const db = require('../db');           // pool mysql2
//   const db = require('../config/db');
//   const knex = require('../knex');
const db = require('../db'); // ← ajuste conforme seu projeto

// Token fixo do DashBot (mesmo que está no EA)
const DASHBOT_TOKEN = 'dashbot2024';

// ── GET /validate-product ─────────────────────────────────────────
router.get('/', async (req, res) => {
  const { account, product, token } = req.query;

  // Helper de resposta de erro
  const deny = (error, status = 403) =>
    res.status(status).json({ valid: false, error });

  // 1. Validar token
  if (!token || token !== DASHBOT_TOKEN)
    return deny('Token inválido.');

  // 2. Validar parâmetros obrigatórios
  if (!account || !product)
    return deny('Parâmetros account e product são obrigatórios.', 400);

  try {
    // ── 3. Verificar se o produto existe ─────────────────────────
    // Tenta primeiro na tabela 'products' (padrão do DashBot v3)
    // Se sua tabela tiver outro nome, ajuste aqui
    let prod = null;
    try {
      const [prodRows] = await db.query(
        'SELECT * FROM products WHERE id = ? AND active = 1 LIMIT 1',
        [product]
      );
      prod = prodRows?.[0] || null;
    } catch {
      // Se a tabela products não existir ainda, continua sem ela
    }

    // Se não achou na tabela products, aceita qualquer prod_* (modo legado)
    if (!prod && !product.startsWith('prod_'))
      return deny('Produto não encontrado.');

    // ── 4. Verificar licença do usuário ───────────────────────────
    // Tenta na tabela 'users' (estrutura padrão do DashBot v3)
    // O campo de conta MT5 pode ser 'account', 'mt5_account' ou 'mt5_login'
    // Ajuste o nome da coluna conforme seu banco
    let user = null;
    const accountNum = parseInt(account, 10);

    // Tentativa 1: tabela users com campo account
    try {
      const [uRows] = await db.query(
        `SELECT * FROM users WHERE account = ? LIMIT 1`,
        [accountNum]
      );
      user = uRows?.[0] || null;
    } catch {}

    // Tentativa 2: campo mt5_account
    if (!user) {
      try {
        const [uRows] = await db.query(
          `SELECT * FROM users WHERE mt5_account = ? LIMIT 1`,
          [accountNum]
        );
        user = uRows?.[0] || null;
      } catch {}
    }

    // Tentativa 3: campo mt5_login
    if (!user) {
      try {
        const [uRows] = await db.query(
          `SELECT * FROM users WHERE mt5_login = ? LIMIT 1`,
          [accountNum]
        );
        user = uRows?.[0] || null;
      } catch {}
    }

    if (!user)
      return deny('Conta MT5 ' + account + ' não encontrada no sistema.');

    // ── 5. Verificar se a licença está ativa ──────────────────────
    // O DashBot v3 usa campo 'plan' ou 'status' e 'expires_at' / 'expiry'
    const plan    = user.plan || user.status || '';
    const expiry  = user.expires_at || user.expiry || user.expiry_date || null;
    const isActive = plan === 'premium' || plan === 'trial' ||
                     plan === 'trial_ext' || plan === 'bonus' ||
                     plan === 'active';

    if (!isActive)
      return deny('Conta sem plano ativo. Acesse o painel DashBot para assinar.');

    // Verificar expiração
    if (expiry) {
      const expiryDate = new Date(expiry);
      if (expiryDate < new Date())
        return deny('Licença expirada em ' + expiryDate.toLocaleDateString('pt-BR') + '. Renove pelo painel DashBot.');
    }

    // ── 6. Buscar configurações personalizadas do produto ─────────
    // Tenta na tabela user_products (se existir)
    let minLots   = 0.01;
    let maxLots   = 10.0;
    let instances = 1;

    try {
      const [upRows] = await db.query(
        `SELECT * FROM user_products
         WHERE user_id = ? AND product_id = ? LIMIT 1`,
        [user.id, product]
      );
      if (upRows?.[0]) {
        minLots   = parseFloat(upRows[0].min_lots   || upRows[0].minLots)   || 0.01;
        maxLots   = parseFloat(upRows[0].max_lots   || upRows[0].maxLots)   || 10.0;
        instances = parseInt (upRows[0].instances   || upRows[0].max_instances) || 1;
      }
    } catch {
      // Tabela user_products não existe — usa defaults
    }

    // ── 7. Registrar último acesso ────────────────────────────────
    try {
      await db.query(
        'UPDATE users SET last_access = NOW() WHERE id = ?',
        [user.id]
      );
    } catch {}

    // ── 8. Retornar sucesso ───────────────────────────────────────
    const expiryDate = expiry ? new Date(expiry) : null;
    return res.json({
      valid:     true,
      account:   accountNum,
      product:   product,
      plan:      plan,
      expiry:    expiryDate ? expiryDate.toISOString().split('T')[0] : null,
      minLots:   minLots,
      maxLots:   maxLots,
      instances: instances,
      name:      user.name || user.username || 'Cliente',
      message:   'Licença ativa'
    });

  } catch (err) {
    console.error('[DashBot /validate-product] Erro:', err.message);
    return res.status(500).json({ valid: false, error: 'Erro interno do servidor.' });
  }
});

module.exports = router;
