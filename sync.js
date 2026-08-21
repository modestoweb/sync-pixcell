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
  connectTimeout: 20000, // 20s para tentar conectar antes de desistir dessa tentativa
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
const TENTATIVAS_CONEXAO = 3;
const ESPERA_ENTRE_TENTATIVAS_MS = 5000;

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

function aguardar(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tenta conectar no banco várias vezes antes de desistir - absorve falhas
// momentâneas de rede (ex: ETIMEDOUT) sem derrubar a sincronização inteira.
async function conectarComRetry() {
  let ultimoErro;

  for (let tentativa = 1; tentativa <= TENTATIVAS_CONEXAO; tentativa++) {
    try {
      const connection = await mysql.createConnection(dbConfig);
      if (tentativa > 1) {
        console.log(`✅ Conectado ao banco na tentativa ${tentativa}`);
      }
      return connection;
    } catch (erro) {
      ultimoErro = erro;
      console.log(`⚠️  Tentativa ${tentativa}/${TENTATIVAS_CONEXAO} de conexão falhou: ${erro.message}`);
      if (tentativa < TENTATIVAS_CONEXAO) {
        await aguardar(ESPERA_ENTRE_TENTATIVAS_MS);
      }
    }
  }

  throw ultimoErro;
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

// Guarda promises em andamento por chave de categoria, para que chamadas
// paralelas pedindo a MESMA categoria aguardem a primeira terminar, em vez
// de disparar duas criações simultâneas (o que causa erro 400 term_exists).
const promisesEmAndamento = new Map();

async function obterOuCriarCategoriaWoo(nome, paiId = null) {
  if (!nome) return null;

  const chaveCache = `${nome}::${paiId || 'root'}`;

  if (cacheCategoriasWoo.has(chaveCache)) {
    return cacheCategoriasWoo.get(chaveCache);
  }

  // Se já existe uma chamada em andamento para essa mesma categoria,
  // aguarda o resultado dela em vez de iniciar outra
  if (promisesEmAndamento.has(chaveCache)) {
    return promisesEmAndamento.get(chaveCache);
  }

  const promise = (async () => {
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
        // Como último recurso: se a criação falhou por já existir (corrida
        // entre chamadas paralelas), tenta buscar de novo antes de desistir
        const buscaNovamente = await WooCommerce.get('products/categories', { search: nome, per_page: 100 });
        const encontrada = buscaNovamente.data.find(
          (c) => c.name.toLowerCase() === nome.toLowerCase() && (paiId ? c.parent === paiId : true)
        );
        if (encontrada) {
          cacheCategoriasWoo.set(chaveCache, encontrada.id);
          return encontrada.id;
        }
        throw erro;
      }
    }

    cacheCategoriasWoo.set(chaveCache, categoria.id);
    return categoria.id;
  })();

  promisesEmAndamento.set(chaveCache, promise);

  try {
    return await promise;
  } finally {
    promisesEmAndamento.delete(chaveCache);
  }
}

// Pré-carrega/cria TODAS as categorias necessárias de uma vez, em paralelo
// (em pequenos grupos de 10), antes de montar os payloads dos produtos.
async function prepararCategoriasEmParalelo(produtos, mapaGrupos) {
  const combinacoesUnicas = new Map();

  for (const { produto } of produtos) {
    const { nomeMae, nomeFilha } = obterCategorias(produto, mapaGrupos);
    if (!nomeMae && !nomeFilha) continue;
    const chave = `${nomeMae || ''}::${nomeFilha || ''}`;
    if (!combinacoesUnicas.has(chave)) {
      combinacoesUnicas.set(chave, { nomeMae, nomeFilha });
    }
  }

  const tarefas = Array.from(combinacoesUnicas.values()).map(({ nomeMae, nomeFilha }) => async () => {
    const idMae = nomeMae ? await obterOuCriarCategoriaWoo(nomeMae) : null;
    if (nomeFilha && nomeFilha !== nomeMae) {
      await obterOuCriarCategoriaWoo(nomeFilha, idMae);
    }
  });

  const TAMANHO_PARALELO = 10;
  for (let i = 0; i < tarefas.length; i += TAMANHO_PARALELO) {
    await Promise.all(tarefas.slice(i, i + TAMANHO_PARALELO).map((fn) => fn()));
  }
}

async function buscarProdutosPixcell(connection) {
  const [rows] = await connection.execute('SELECT * FROM site_productos');
  return rows;
}

// Busca TODOS os produtos do WooCommerce de uma vez, paginando, e monta um mapa SKU -> produto.
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

// Monta o payload de criação de um produto. NÃO busca imagem - isso agora é
// responsabilidade do plugin do WordPress (associa no momento do upload).
function montarPayloadCriacao(produto, sku, mapaGrupos) {
  const { nomeMae, nomeFilha } = obterCategorias(produto, mapaGrupos);
  const categorias = [];

  const idMae = nomeMae ? cacheCategoriasWoo.get(`${nomeMae}::root`) : null;
  if (nomeFilha && nomeFilha !== nomeMae) {
    const idFilha = cacheCategoriasWoo.get(`${nomeFilha}::${idMae || 'root'}`);
    if (idFilha) categorias.push({ id: idFilha });
    else if (idMae) categorias.push({ id: idMae });
  } else if (idMae) {
    categorias.push({ id: idMae });
  }

  return {
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
}

// Compara preço e estoque do banco Pixcell com o que já está no WooCommerce.
// Preço é comparado como número (não como texto), pois o WooCommerce pode
// devolver formatos como "150.00" enquanto o banco manda "150" - mesmo valor,
// texto diferente. Usa uma pequena tolerância para evitar diferença de
// arredondamento (ex: 150 vs 150.0001) disparar atualização à toa.
function produtoMudou(produto, produtoWoo) {
  const precoNovo = Number(produto.preco_a) || 0;
  const precoAtual = Number(produtoWoo.regular_price) || 0;
  const estoqueNovo = Number(produto.dep01) || 0;
  const estoqueAtual = Number(produtoWoo.stock_quantity) || 0;

  const precoMudou = Math.abs(precoNovo - precoAtual) > 0.005; // tolerância de meio centavo
  const estoqueMudou = estoqueNovo !== estoqueAtual;

  return precoMudou || estoqueMudou;
}

// Monta o payload de atualização de um produto existente (sem busca de imagem)
function montarPayloadAtualizacao(produto, produtoWoo) {
  return {
    id: produtoWoo.id,
    regular_price: String(produto.preco_a),
    stock_quantity: produto.dep01,
    manage_stock: true,
    stock_status: produto.dep01 > 0 ? 'instock' : 'outofstock',
  };
}

// Envia um lote (até 100 produtos) para o endpoint batch do WooCommerce.
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

  const connection = await conectarComRetry();

  try {
    const mapaGrupos = await carregarMapaGrupos(connection);
    console.log(`🗂️  ${mapaGrupos.size} grupos/categorias carregados do banco`);

    console.log(`🔎 Carregando produtos existentes no WooCommerce...`);
    const mapaProdutosWoo = await carregarMapaProdutosWoo();
    console.log(`🔎 ${mapaProdutosWoo.size} produtos já existentes encontrados no WooCommerce`);

    const produtos = await buscarProdutosPixcell(connection);
    console.log(`📦 ${produtos.length} produtos encontrados no banco Pixcell`);

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

    console.log(`⚙️  Preparando categorias em paralelo...`);
    try {
      await prepararCategoriasEmParalelo(paraProcessar, mapaGrupos);
    } catch (erroCategoria) {
      console.log(`⚠️  Erro ao preparar categorias em paralelo (algumas podem ficar sem categoria nesta rodada): ${erroCategoria.message}`);
    }

    console.log(`⚙️  ${paraProcessar.length} produtos a processar em lotes de ${TAMANHO_LOTE}...`);

    let criados = 0;
    let semMudanca = 0;
    let atualizados = 0;
    let comErro = 0;
    const erros = [];

    const lotes = dividirEmLotes(paraProcessar, TAMANHO_LOTE);

    for (let i = 0; i < lotes.length; i++) {
      const lote = lotes[i];
      const payloadCriar = [];
      const payloadAtualizar = [];

      for (const { produto, sku } of lote) {
        const produtoWoo = mapaProdutosWoo.get(sku.toLowerCase());
        if (produtoWoo) {
          if (produtoMudou(produto, produtoWoo)) {
            payloadAtualizar.push(montarPayloadAtualizacao(produto, produtoWoo));
          } else {
            semMudanca++;
          }
        } else {
          payloadCriar.push(montarPayloadCriacao(produto, sku, mapaGrupos));
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
    console.log(`Criados: ${criados} | Atualizados: ${atualizados} | Sem mudança (pulados): ${semMudanca} | Ignorados (grupo excluído): ${ignorados} | Pulados (sem identificador): ${semIdentificador} | Com erro: ${comErro}`);

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