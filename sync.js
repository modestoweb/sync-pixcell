require('dotenv').config({ path: require('fs').existsSync('.env') ? '.env' : undefined });
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
const MODO_TESTE = false;
const TAMANHO_LOTE = 100; // máximo aceito pelo endpoint products/batch do WooCommerce

const cacheCategoriasWoo = new Map();

// ---- Funções auxiliares (iguais à versão anterior) ----

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

async function buscarImagemPorSku(sku) {
  try {
    const wpUrl = `${process.env.WC_URL}/wp-json/wp/v2/media`;
    const auth = Buffer.from(`${process.env.WC_CONSUMER_KEY}:${process.env.WC_CONSUMER_SECRET}`).toString('base64');

    const resposta = await require('axios').get(wpUrl, {
      params: { search: sku, per_page: 5 },
      headers: { Authorization: `Basic ${auth}` },
    });

    if (resposta.data && resposta.data.length > 0) {
      const match = resposta.data.find((midia) => {
        const nomeArquivo = midia.slug || '';
        return nomeArquivo.toLowerCase() === sku.toLowerCase();
      });
      return match ? match.source_url : null;
    }
    return null;
  } catch (erro) {
    return null;
  }
}

function produtoTemImagem(produtoWoo) {
  return produtoWoo && produtoWoo.images && produtoWoo.images.length > 0;
}

async function buscarProdutosPixcell(connection) {
  const [rows] = await connection.execute('SELECT * FROM site_productos');
  return rows;
}

// Busca TODOS os produtos do WooCommerce de uma vez, paginando, e monta um mapa SKU -> produto.
// Isso evita fazer uma chamada de API por produto só para "ver se já existe".
async function carregarMapaProdutosWoo() {
  const mapa = new Map();
  let pagina = 1;
  let continuar = true;

  while (continuar) {
    const resposta = await WooCommerce.get('products', { per_page: 100, page: pagina, status: 'any' });
    for (const p of resposta.data) {
      if (p.sku) mapa.set(p.sku.toLowerCase(), p);
    }
    continuar = resposta.data.length === 100;
    pagina++;
  }

  return mapa;
}

function dividirEmLotes(array, tamanho) {
  const lotes = [];
  for (let i = 0; i < array.length; i += tamanho) {
    lotes.push(array.slice(i, i + tamanho));
  }
  return lotes;
}

// Monta o payload de criação de um produto (mesma lógica de antes)
async function montarPayloadCriacao(produto, sku, mapaGrupos) {
  const categorias = await resolverCategoriaIds(produto, mapaGrupos);
  const imagemUrl = await buscarImagemPorSku(sku);

  const payload = {
    sku: sku,
    name: produto.descricao,
    regular_price: String(produto.preco_a),
    description: produto.descricao,
    stock_quantity: produto.dep01,
    manage_stock: true,
    stock_status: produto.dep01 > 0 ? 'instock' : 'outofstock',
    status: MODO_TESTE ? 'draft' : 'publish',
    categories: categorias,
  };

  if (imagemUrl) {
    payload.images = [{ src: imagemUrl }];
  }

  return payload;
}

// Monta o payload de atualização de um produto existente
async function montarPayloadAtualizacao(produto, sku, produtoWoo) {
  const payload = {
    id: produtoWoo.id,
    regular_price: String(produto.preco_a),
    stock_quantity: produto.dep01,
    manage_stock: true,
    stock_status: produto.dep01 > 0 ? 'instock' : 'outofstock',
  };

  if (!produtoTemImagem(produtoWoo)) {
    const imagemUrl = await buscarImagemPorSku(sku);
    if (imagemUrl) {
      payload.images = [{ src: imagemUrl }];
    }
  }

  return payload;
}

// Envia um lote (até 100 produtos) para o endpoint batch do WooCommerce.
// A API processa cada item de forma independente - um erro num item não afeta os outros.
async function enviarLote(payloadCriar, payloadAtualizar) {
  const corpo = {};
  if (payloadCriar.length > 0) corpo.create = payloadCriar;
  if (payloadAtualizar.length > 0) corpo.update = payloadAtualizar;

  if (payloadCriar.length === 0 && payloadAtualizar.length === 0) {
    return { create: [], update: [] };
  }

  const resposta = await WooCommerce.post('products/batch', corpo);
  return resposta.data;
}

// ---- Função principal ----

async function sincronizar() {
  console.log(`\n--- Iniciando sincronização: ${new Date().toLocaleString('pt-BR')} ---`);

  const connection = await mysql.createConnection(dbConfig);

  try {
    const mapaGrupos = await carregarMapaGrupos(connection);
    console.log(`🗂️  ${mapaGrupos.size} grupos/categorias carregados do banco`);

    console.log(`🔎 Carregando produtos existentes no WooCommerce...`);
    const mapaProdutosWoo = await carregarMapaProdutosWoo();
    console.log(`🔎 ${mapaProdutosWoo.size} produtos já existentes encontrados no WooCommerce`);

    const produtos = await buscarProdutosPixcell(connection);
    console.log(`📦 ${produtos.length} produtos encontrados no banco Pixcell`);

    // Separa os produtos a processar dos ignorados/pulados, sem bater na API ainda
    const paraProcessar = [];
    let ignorados = 0;
    let semIdentificador = 0;

    for (const produto of produtos) {
      if (grupoExcluido(produto.classif)) {
        ignorados++;
        continue;
      }
      const sku = obterSku(produto);
      if (!sku) {
        semIdentificador++;
        continue;
      }
      paraProcessar.push({ produto, sku });
    }

    console.log(`⚙️  ${paraProcessar.length} produtos a processar em lotes de ${TAMANHO_LOTE}...`);

    let criados = 0;
    let atualizados = 0;
    let comErro = 0;
    const erros = [];

    const lotes = dividirEmLotes(paraProcessar, TAMANHO_LOTE);

    for (let i = 0; i < lotes.length; i++) {
      const lote = lotes[i];
      const payloadCriar = [];
      const payloadAtualizar = [];

      // Monta os payloads do lote (aqui ainda busca categoria/imagem individualmente,
      // mas o ENVIO final é em lote - a parte lenta de rede é o que reduz)
      for (const { produto, sku } of lote) {
        const produtoWoo = mapaProdutosWoo.get(sku.toLowerCase());
        if (produtoWoo) {
          payloadAtualizar.push(await montarPayloadAtualizacao(produto, sku, produtoWoo));
        } else {
          payloadCriar.push(await montarPayloadCriacao(produto, sku, mapaGrupos));
        }
      }

      try {
        const resultado = await enviarLote(payloadCriar, payloadAtualizar);

        for (const item of resultado.create || []) {
          if (item.error) {
            comErro++;
            erros.push(`Criar ${item.sku || '?'}: ${item.error.message}`);
          } else {
            criados++;
          }
        }
        for (const item of resultado.update || []) {
          if (item.error) {
            comErro++;
            erros.push(`Atualizar ${item.sku || item.id}: ${item.error.message}`);
          } else {
            atualizados++;
          }
        }

        console.log(`📦 Lote ${i + 1}/${lotes.length} enviado (${payloadCriar.length} criar, ${payloadAtualizar.length} atualizar)`);
      } catch (erroLote) {
        comErro += lote.length;
        erros.push(`Lote ${i + 1} falhou inteiro: ${erroLote.message}`);
        console.log(`❌ Erro no lote ${i + 1}: ${erroLote.message}`);
      }
    }

    console.log(`\n--- Sincronização concluída ---`);
    console.log(`Criados: ${criados} | Atualizados: ${atualizados} | Ignorados (grupo excluído): ${ignorados} | Pulados (sem identificador): ${semIdentificador} | Com erro: ${comErro}`);

    if (erros.length > 0) {
      console.log(`\nDetalhes dos erros:`);
      erros.slice(0, 20).forEach((e) => console.log(`  - ${e}`));
      if (erros.length > 20) console.log(`  ... e mais ${erros.length - 20} erro(s)`);
    }
  } catch (erro) {
    console.error('❌ Erro geral durante a sincronização:', erro.message);
  } finally {
    await connection.end();
  }
}

sincronizar();