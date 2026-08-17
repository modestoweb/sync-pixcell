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

const GRUPOS_EXCLUIDOS = ['1.01.10', '1.01.11'];
const MODO_TESTE = true;
const LIMITE_TESTE = 30;

const cacheCategoriasWoo = new Map();

// ---- Funções auxiliares ----

function grupoExcluido(classif) {
  return GRUPOS_EXCLUIDOS.some((codigo) => classif && classif.startsWith(codigo));
}

function obterSku(produto) {
  if (produto.referencia && produto.referencia.trim() !== '') {
    return String(produto.referencia).trim();
  }
  if (produto.digito !== null && produto.digito !== undefined && String(produto.digito).trim() !== '') {
    return `DIG-${produto.digito}`;
  }
  return null;
}

function normalizarClassif(classif) {
  if (!classif) return '';
  return classif
    .split('.')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('.');
}

function codigoCategoriaMae(classifNormalizado) {
  const partes = classifNormalizado.split('.');
  if (partes.length < 3) return null;
  return partes.slice(0, 3).join('.');
}

async function carregarMapaGrupos(connection) {
  const [rows] = await connection.execute('SELECT classif, descricao FROM site_grupos');
  const mapa = new Map();
  for (const row of rows) {
    const chave = normalizarClassif(row.classif);
    if (chave) mapa.set(chave, row.descricao.trim());
  }
  return mapa;
}

function obterCategorias(produto, mapaGrupos) {
  const classifNorm = normalizarClassif(produto.classif);
  const nomeFilha = mapaGrupos.get(classifNorm);
  const codigoMae = codigoCategoriaMae(classifNorm);
  const nomeMae = codigoMae ? mapaGrupos.get(codigoMae) : null;
  return { nomeMae, nomeFilha };
}

async function obterOuCriarCategoriaWoo(nome, paiId = null) {
  if (!nome) return null;

  const chaveCache = `${nome}::${paiId || 'root'}`;
  if (cacheCategoriasWoo.has(chaveCache)) {
    return cacheCategoriasWoo.get(chaveCache);
  }

  const busca = await WooCommerce.get('products/categories', { search: nome, per_page: 100 });
  let categoria = busca.data.find(
    (c) => c.name.toLowerCase() === nome.toLowerCase() && (paiId ? c.parent === paiId : true)
  );

  if (!categoria) {
    try {
      const payload = { name: nome };
      if (paiId) payload.parent = paiId;
      const resposta = await WooCommerce.post('products/categories', payload);
      categoria = resposta.data;
      console.log(`📂 Categoria criada: ${nome}${paiId ? ' (subcategoria)' : ''}`);
    } catch (erro) {
      const idExistente = erro.response?.data?.resource_id;
      if (idExistente) {
        cacheCategoriasWoo.set(chaveCache, idExistente);
        return idExistente;
      }
      throw erro;
    }
  }

  cacheCategoriasWoo.set(chaveCache, categoria.id);
  return categoria.id;
}

async function resolverCategoriaIds(produto, mapaGrupos) {
  const { nomeMae, nomeFilha } = obterCategorias(produto, mapaGrupos);
  if (!nomeMae && !nomeFilha) return [];

  const idMae = nomeMae ? await obterOuCriarCategoriaWoo(nomeMae) : null;

  if (nomeFilha && nomeFilha !== nomeMae) {
    const idFilha = await obterOuCriarCategoriaWoo(nomeFilha, idMae);
    return idFilha ? [{ id: idFilha }] : idMae ? [{ id: idMae }] : [];
  }

  return idMae ? [{ id: idMae }] : [];
}

// Procura na Biblioteca de Mídia do WordPress uma imagem cujo nome de arquivo
// (sem extensão) bata com o SKU do produto. Retorna a URL da imagem, ou null.
async function buscarImagemPorSku(sku) {
  try {
    // Usa a API REST nativa do WordPress (wp/v2/media), não a do WooCommerce
    const wpUrl = `${process.env.WC_URL}/wp-json/wp/v2/media`;
    const auth = Buffer.from(`${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`).toString('base64');

    const resposta = await require('axios').get(wpUrl, {
      params: { search: sku, per_page: 5 },
      headers: { Authorization: `Basic ${auth}` },
    });

    if (resposta.data && resposta.data.length > 0) {
      // Confirma que o nome do arquivo (sem extensão) bate exatamente com o SKU
      const match = resposta.data.find((midia) => {
        const nomeArquivo = midia.slug || '';
        return nomeArquivo.toLowerCase() === sku.toLowerCase();
      });
      return match ? match.source_url : null;
    }
    return null;
  } catch (erro) {
    return null; // se a busca falhar, simplesmente não associa imagem (não trava o produto)
  }
}

// Verifica se o produto já tem imagem no WooCommerce
function produtoTemImagem(produtoWoo) {
  return produtoWoo && produtoWoo.images && produtoWoo.images.length > 0;
}

async function buscarProdutosPixcell(connection) {
  const [rows] = await connection.execute('SELECT * FROM site_productos');
  return rows;
}

async function buscarProdutoWooPorSku(sku) {
  const response = await WooCommerce.get('products', { sku });
  return response.data.length > 0 ? response.data[0] : null;
}

async function criarProdutoWoo(produtoPixcell, sku, categorias, imagemUrl) {
  const payload = {
    sku: sku,
    name: produtoPixcell.descricao,
    regular_price: String(produtoPixcell.preco_a),
    description: produtoPixcell.descricao,
    stock_quantity: produtoPixcell.dep01,
    manage_stock: true,
    stock_status: produtoPixcell.dep01 > 0 ? 'instock' : 'outofstock',
    status: MODO_TESTE ? 'draft' : 'publish',
    categories: categorias,
  };

  if (imagemUrl) {
    payload.images = [{ src: imagemUrl }];
  }

  const response = await WooCommerce.post('products', payload);
  console.log(`✅ Criado: ${sku} - ${produtoPixcell.descricao}${imagemUrl ? ' 🖼️' : ''}`);
  return response.data;
}

async function atualizarProdutoWoo(produtoWoo, produtoPixcell, sku) {
  const payload = {
    regular_price: String(produtoPixcell.preco_a),
    stock_quantity: produtoPixcell.dep01,
    manage_stock: true,
    stock_status: produtoPixcell.dep01 > 0 ? 'instock' : 'outofstock',
  };

  // Se o produto ainda NÃO tem imagem, verifica se apareceu uma na Biblioteca de Mídia
  // (cobre o caso de alguém subir a foto DEPOIS do produto já existir)
  if (!produtoTemImagem(produtoWoo)) {
    const imagemUrl = await buscarImagemPorSku(sku);
    if (imagemUrl) {
      payload.images = [{ src: imagemUrl }];
      console.log(`🖼️  Imagem encontrada e associada: ${sku}`);
    }
  }

  await WooCommerce.put(`products/${produtoWoo.id}`, payload);
  console.log(`🔄 Atualizado: ${sku} - preço/estoque`);
}

// ---- Função principal ----

async function sincronizar() {
  console.log(`\n--- Iniciando sincronização: ${new Date().toLocaleString('pt-BR')} ---`);

  const connection = await mysql.createConnection(dbConfig);

  try {
    const mapaGrupos = await carregarMapaGrupos(connection);
    console.log(`🗂️  ${mapaGrupos.size} grupos/categorias carregados do banco`);

    let produtos = await buscarProdutosPixcell(connection);
    produtos = produtos.slice(0, LIMITE_TESTE);
    console.log(`📦 ${produtos.length} produtos encontrados no banco Pixcell (testando com ${LIMITE_TESTE})`);

    let criados = 0;
    let atualizados = 0;
    let ignorados = 0;
    let semIdentificador = 0;
    let comErro = 0;

    for (const produto of produtos) {
      try {
        if (grupoExcluido(produto.classif)) {
          ignorados++;
          continue;
        }

        const sku = obterSku(produto);

        if (!sku) {
          console.log(`⚠️  Pulado (sem referencia nem digito): ${produto.descricao}`);
          semIdentificador++;
          continue;
        }

        const produtoWoo = await buscarProdutoWooPorSku(sku);

        if (produtoWoo) {
          await atualizarProdutoWoo(produtoWoo, produto, sku);
          atualizados++;
        } else {
          const categorias = await resolverCategoriaIds(produto, mapaGrupos);
          const imagemUrl = await buscarImagemPorSku(sku);
          await criarProdutoWoo(produto, sku, categorias, imagemUrl);
          criados++;
        }
      } catch (erroProduto) {
        comErro++;
        const detalhe = erroProduto.response?.data?.message || erroProduto.message;
        console.log(`❌ Erro no produto "${produto.descricao}" (classif: ${produto.classif}): ${detalhe}`);
        continue;
      }
    }

    console.log(`\n--- Sincronização concluída ---`);
    console.log(`Criados: ${criados} | Atualizados: ${atualizados} | Ignorados (grupo excluído): ${ignorados} | Pulados (sem identificador): ${semIdentificador} | Com erro: ${comErro}`);
  } catch (erro) {
    console.error('❌ Erro geral durante a sincronização:', erro.message);
  } finally {
    await connection.end();
  }
}

sincronizar();