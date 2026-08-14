require('dotenv').config();
const mysql = require('mysql2/promise');
const WooCommerceRestApi = require('@woocommerce/woocommerce-rest-api').default;

// ---- Configuração ----

const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
};

const WooCommerce = new WooCommerceRestApi({
  url: process.env.WC_URL,
  consumerKey: process.env.WC_CONSUMER_KEY,
  consumerSecret: process.env.WC_CONSUMER_SECRET,
  version: 'wc/v3',
});

// Grupos a excluir da sincronização (AJUSTAR quando o cliente confirmar os códigos exatos)
const GRUPOS_EXCLUIDOS = ['1.01.10', '1.01.11'];

// Se true, cria os produtos como RASCUNHO (não aparece pro público) - usar nos testes
const MODO_TESTE = true;

// Quantidade de produtos pra testar primeiro (segurança)
const LIMITE_TESTE = 5;

// ---- Funções auxiliares ----

function grupoExcluido(classif) {
  return GRUPOS_EXCLUIDOS.some((codigo) => classif && classif.startsWith(codigo));
}

async function buscarProdutosPixcell(connection) {
  const [rows] = await connection.execute('SELECT * FROM site_productos');
  return rows;
}

async function buscarProdutoWooPorSku(sku) {
  const response = await WooCommerce.get('products', { sku });
  return response.data.length > 0 ? response.data[0] : null;
}

async function criarProdutoWoo(produtoPixcell) {
  const payload = {
    sku: produtoPixcell.referencia,
    name: produtoPixcell.descricao,
    regular_price: String(produtoPixcell.preco_a),
    description: produtoPixcell.descricao,
    stock_quantity: produtoPixcell.dep01,
    manage_stock: true,
    stock_status: produtoPixcell.dep01 > 0 ? 'instock' : 'outofstock',
    status: MODO_TESTE ? 'draft' : 'publish',
  };

  const response = await WooCommerce.post('products', payload);
  console.log(`✅ Criado: ${produtoPixcell.referencia} - ${produtoPixcell.descricao}`);
  return response.data;
}

async function atualizarProdutoWoo(produtoWooId, produtoPixcell) {
  const payload = {
    regular_price: String(produtoPixcell.preco_a),
    stock_quantity: produtoPixcell.dep01,
    manage_stock: true,
    stock_status: produtoPixcell.dep01 > 0 ? 'instock' : 'outofstock',
    // Nota: description NÃO entra aqui de propósito - só atualiza na criação
  };

  await WooCommerce.put(`products/${produtoWooId}`, payload);
  console.log(`🔄 Atualizado: ${produtoPixcell.referencia} - preço/estoque`);
}

// ---- Função principal ----

async function sincronizar() {
  console.log(`\n--- Iniciando sincronização: ${new Date().toLocaleString('pt-BR')} ---`);

  const connection = await mysql.createConnection(dbConfig);

  try {
    let produtos = await buscarProdutosPixcell(connection);
    produtos = produtos.slice(0, LIMITE_TESTE); // remove essa linha quando for rodar com a base toda
    console.log(`📦 ${produtos.length} produtos encontrados no banco Pixcell (testando com ${LIMITE_TESTE})`);

    let criados = 0;
    let atualizados = 0;
    let ignorados = 0;

    for (const produto of produtos) {
      if (grupoExcluido(produto.classif)) {
        ignorados++;
        continue;
      }

      const produtoWoo = await buscarProdutoWooPorSku(produto.referencia);

      if (produtoWoo) {
        await atualizarProdutoWoo(produtoWoo.id, produto);
        atualizados++;
      } else {
        await criarProdutoWoo(produto);
        criados++;
      }
    }

    console.log(`\n--- Sincronização concluída ---`);
    console.log(`Criados: ${criados} | Atualizados: ${atualizados} | Ignorados (grupo excluído): ${ignorados}`);
  } catch (erro) {
    console.error('❌ Erro durante a sincronização:', erro.message);
  } finally {
    await connection.end();
  }
}

sincronizar();