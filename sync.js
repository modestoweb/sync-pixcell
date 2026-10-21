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
const MODO_TESTE = process.env.MODO_TESTE === 'true';
// SIMULAR=true: lê tudo e mostra no log o que FARIA, mas não grava nada no WooCommerce.
const SIMULAR = process.env.SIMULAR === 'true';
const TAMANHO_LOTE = 100; // máximo aceito pelo endpoint products/batch do WooCommerce
const TENTATIVAS_CONEXAO = 3;
const ESPERA_ENTRE_TENTATIVAS_MS = 5000;
const MAX_LINHAS_LOG_DETALHE = 50;

const cacheCategoriasWoo = new Map();

// ---- Funções auxiliares ----

function grupoExcluido(classif) {
  return GRUPOS_EXCLUIDOS.some((codigo) => classif && classif.startsWith(codigo));
}

// SKU definitivo do produto: SEMPRE baseado no campo "digito", nunca na
// "referencia" (mesmo quando ela existe). Padrão combinado com o cliente
// para manter os produtos organizados de forma consistente.
function obterSku(produto) {
  if (produto.digito === null || produto.digito === undefined) return null;
  // Remove espaços e caracteres invisíveis (ex.: espaço de largura zero vindo do sistema)
  const digito = String(produto.digito).replace(/[^\x21-\x7E]/g, '');
  if (digito === '') return null;
  return `DIG-${digito}`;
}

// SKU "antigo" que esse produto poderia ter recebido antes desta mudança de
// regra (quando a referencia, se existisse, era usada como SKU). Usado só
// para LOCALIZAR produtos já criados com o padrão antigo, e migrar o SKU
// deles para o padrão novo (digito) sem duplicar o produto.
function obterSkuAntigo(produto) {
  if (produto.referencia && String(produto.referencia).trim() !== '') {
    return String(produto.referencia).trim();
  }
  return null;
}

// O mysql2 devolve DECIMAL como texto ("12.50"); alguns sistemas gravam
// com vírgula ("12,50"). Converte tudo para número, ou null se inválido.
function lerPreco(valor) {
  if (valor === null || valor === undefined || String(valor).trim() === '') return null;
  const numero = Number(String(valor).trim().replace(',', '.'));
  return Number.isFinite(numero) && numero > 0 ? numero : null;
}

// O WooCommerce exige estoque inteiro. "5.000" -> 5, negativo -> 0.
function lerEstoque(valor) {
  const numero = Math.trunc(Number(String(valor ?? '0').replace(',', '.')));
  return Number.isFinite(numero) && numero > 0 ? numero : 0;
}

function formatarPreco(numero) {
  return numero.toFixed(2);
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
    if (chave && row.descricao) mapa.set(chave, String(row.descricao).trim());
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

// O WooCommerce devolve nomes com HTML ("A &amp; B"); decodifica para comparar.
function decodificarHtml(texto) {
  return String(texto || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function categoriaConfere(c, nome, paiId) {
  const mesmoNome = decodificarHtml(c.name).toLowerCase() === nome.toLowerCase();
  // Categoria raiz precisa ter parent 0; subcategoria precisa ter o pai certo
  const mesmoPai = paiId ? c.parent === paiId : c.parent === 0;
  return mesmoNome && mesmoPai;
}

const promisesEmAndamento = new Map();

async function obterOuCriarCategoriaWoo(nome, paiId = null) {
  if (!nome) return null;

  const chaveCache = `${nome}::${paiId || 'root'}`;

  if (cacheCategoriasWoo.has(chaveCache)) {
    return cacheCategoriasWoo.get(chaveCache);
  }

  if (promisesEmAndamento.has(chaveCache)) {
    return promisesEmAndamento.get(chaveCache);
  }

  const promise = (async () => {
    const busca = await WooCommerce.get('products/categories', { search: nome, per_page: 100 });
    let categoria = busca.data.find((c) => categoriaConfere(c, nome, paiId));

    if (!categoria && SIMULAR) {
      console.log(`🧪 [SIMULAÇÃO] Criaria categoria: ${nome}${paiId ? ' (subcategoria)' : ''}`);
      return null;
    }

    if (!categoria) {
      try {
        const payload = { name: nome };
        if (paiId) payload.parent = paiId;
        const resposta = await WooCommerce.post('products/categories', payload);
        categoria = resposta.data;
        console.log(`📂 Categoria criada: ${nome}${paiId ? ' (subcategoria)' : ''}`);
      } catch (erro) {
        const idExistente = erro.response?.data?.data?.resource_id || erro.response?.data?.resource_id;
        if (idExistente) {
          cacheCategoriasWoo.set(chaveCache, idExistente);
          return idExistente;
        }
        const buscaNovamente = await WooCommerce.get('products/categories', { search: nome, per_page: 100 });
        const encontrada = buscaNovamente.data.find((c) => categoriaConfere(c, nome, paiId));
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

// Pede ao Woo só os campos usados (_fields) - a listagem fica bem mais leve
// e rápida do que baixar o produto inteiro (descrição, imagens, etc).
async function carregarMapaProdutosWoo() {
  const mapa = new Map();
  let pagina = 1;
  let continuar = true;

  while (continuar) {
    const resposta = await WooCommerce.get('products', {
      per_page: 100,
      page: pagina,
      status: 'any',
      // Ordena por ID (único). A ordem padrão é por data e, como muitos produtos
      // foram criados no mesmo segundo pelo batch, a paginação "pulava" alguns.
      orderby: 'id',
      order: 'asc',
      _fields: 'id,sku,name,type,status,regular_price,sale_price,stock_quantity',
    });
    for (const p of resposta.data) {
      if (p.sku) mapa.set(String(p.sku).toLowerCase(), p);
    }
    continuar = resposta.data.length === 100;
    pagina++;
  }

  return mapa;
}

async function buscarProdutoPorSku(sku) {
  try {
    const resposta = await WooCommerce.get('products', {
      sku,
      status: 'any',
      _fields: 'id,sku,name,type,status,regular_price,sale_price,stock_quantity',
    });
    return resposta.data && resposta.data.length > 0 ? resposta.data[0] : null;
  } catch (erro) {
    console.log(`⚠️  Busca direta do SKU ${sku} falhou: ${erro.message}`);
    return null;
  }
}

function dividirEmLotes(array, tamanho) {
  const lotes = [];
  for (let i = 0; i < array.length; i += tamanho) {
    lotes.push(array.slice(i, i + tamanho));
  }
  return lotes;
}

function montarPayloadCriacao(produto, sku, preco, estoque, mapaGrupos) {
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
    regular_price: formatarPreco(preco),
    description: produto.descricao,
    stock_quantity: estoque,
    manage_stock: true,
    stock_status: estoque > 0 ? 'instock' : 'outofstock',
    status: MODO_TESTE ? 'draft' : 'publish',
    categories: categorias,
  };
}

function compararProduto(preco, estoque, produtoWoo) {
  const precoAtual = Number(produtoWoo.regular_price) || 0;
  const estoqueAtual = Number(produtoWoo.stock_quantity) || 0;
  return {
    precoMudou: Math.abs(preco - precoAtual) > 0.005,
    estoqueMudou: estoque !== estoqueAtual,
    precoAtual,
    estoqueAtual,
  };
}

// Monta o payload de atualização. Quando o produto foi localizado pelo SKU
// ANTIGO (referencia), o payload também inclui o novo SKU (digito) - migra
// a identificação sem duplicar o produto.
function montarPayloadAtualizacao(produtoWoo, preco, estoque, novoSku, precisaMigrarSku) {
  const payload = {
    id: produtoWoo.id,
    regular_price: formatarPreco(preco),
    stock_quantity: estoque,
    manage_stock: true,
    stock_status: estoque > 0 ? 'instock' : 'outofstock',
  };

  if (precisaMigrarSku) {
    payload.sku = novoSku;
  }

  return payload;
}

async function enviarLote(payloadCriar, payloadAtualizar) {
  const corpo = {};
  if (payloadCriar.length > 0) corpo.create = payloadCriar;
  if (payloadAtualizar.length > 0) corpo.update = payloadAtualizar;

  if (payloadCriar.length === 0 && payloadAtualizar.length === 0) {
    return { create: [], update: [] };
  }

  if (SIMULAR) {
    payloadCriar.forEach((p) => console.log(`🧪 [SIMULAÇÃO] Criaria ${p.sku} (${p.name}) por ${p.regular_price}`));
    return {
      create: payloadCriar.map((p) => ({ sku: p.sku })),
      update: payloadAtualizar.map((p) => ({ id: p.id, sku: p.sku })),
    };
  }

  const resposta = await WooCommerce.post('products/batch', corpo);
  return resposta.data;
}

function imprimirLista(titulo, linhas) {
  if (linhas.length === 0) return;
  console.log(`\n${titulo} (${linhas.length}):`);
  linhas.slice(0, MAX_LINHAS_LOG_DETALHE).forEach((l) => console.log(`  - ${l}`));
  if (linhas.length > MAX_LINHAS_LOG_DETALHE) {
    console.log(`  ... e mais ${linhas.length - MAX_LINHAS_LOG_DETALHE}`);
  }
}

// ---- Função principal ----

// Retorna true se tudo correu bem, false se houve qualquer erro.
async function sincronizar() {
  const inicio = Date.now();
  if (SIMULAR) {
    console.log('🧪🧪🧪 MODO SIMULAÇÃO: nada será gravado no WooCommerce 🧪🧪🧪');
  }
  console.log(
    `\n--- Iniciando sincronização: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} ---`
  );

  const connection = await conectarComRetry();

  try {
    const mapaGrupos = await carregarMapaGrupos(connection);
    console.log(`🗂️  ${mapaGrupos.size} grupos/categorias carregados do banco`);

    console.log(`🔎 Carregando produtos existentes no WooCommerce...`);
    const mapaProdutosWoo = await carregarMapaProdutosWoo();
    console.log(`🔎 ${mapaProdutosWoo.size} produtos já existentes encontrados no WooCommerce`);

    const produtos = await buscarProdutosPixcell(connection);
    console.log(`📦 ${produtos.length} produtos encontrados no banco Pixcell`);

    // INSPECIONAR=22060,1001 : mostra a linha COMPLETA do sistema (todas as colunas)
    // e o produto correspondente no site, para comparar preço por preço.
    const inspecionar = (process.env.INSPECIONAR || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (inspecionar.length > 0) {
      console.log(`\n🔬 ===== INSPEÇÃO =====`);
      if (produtos[0]) console.log(`Colunas da tabela site_productos: ${Object.keys(produtos[0]).join(', ')}`);
      for (const d of inspecionar) {
        const linhas = produtos.filter((p) => String(p.digito ?? '').trim() === d);
        console.log(`\n🔬 Dígito ${d}: ${linhas.length} linha(s) no sistema`);
        linhas.forEach((l) => console.log(JSON.stringify(l, null, 2)));
        const sku = `DIG-${d}`;
        const woo = mapaProdutosWoo.get(sku.toLowerCase()) || (await buscarProdutoPorSku(sku));
        console.log(`🔬 No site (${sku}): ${woo ? JSON.stringify(woo) : 'NÃO ENCONTRADO'}`);
      }
      console.log(`🔬 ===== FIM DA INSPEÇÃO =====\n`);
    }

    const paraProcessar = [];
    let ignorados = 0;
    let semIdentificador = 0;
    const semPreco = [];

    // SKU repetido no sistema (ex.: vários produtos com digito = 0) faria
    // todos eles sobrescreverem o MESMO produto no site, um após o outro.
    // Esses produtos são pulados e listados no log até o cadastro ser corrigido.
    const contagemSku = new Map();
    for (const produto of produtos) {
      if (grupoExcluido(produto.classif)) continue;
      const sku = obterSku(produto);
      if (sku) contagemSku.set(sku.toLowerCase(), (contagemSku.get(sku.toLowerCase()) || 0) + 1);
    }
    const skuDuplicado = [];

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
      if (contagemSku.get(sku.toLowerCase()) > 1) {
        skuDuplicado.push(`${sku} (${produto.descricao}) - preço no sistema ${produto.preco_a}`);
        continue;
      }
      const preco = lerPreco(produto.preco_a);
      if (preco === null) {
        semPreco.push(`${sku} (${produto.descricao}): preco_a = ${produto.preco_a}`);
        continue;
      }
      const estoque = lerEstoque(produto.dep01);
      const skuAntigo = obterSkuAntigo(produto);
      paraProcessar.push({ produto, sku, skuAntigo, preco, estoque });
    }

    console.log(`⚙️  Preparando categorias em paralelo...`);
    try {
      await prepararCategoriasEmParalelo(paraProcessar, mapaGrupos);
    } catch (erroCategoria) {
      console.log(`⚠️  Erro ao preparar categorias em paralelo: ${erroCategoria.message}`);
    }

    console.log(`⚙️  ${paraProcessar.length} produtos a processar em lotes de ${TAMANHO_LOTE}...`);

    let criados = 0;
    let semMudanca = 0;
    let atualizados = 0;
    let migrados = 0;
    let comErro = 0;
    const erros = [];
    const mudancasPreco = [];
    const avisosPromocao = [];
    const avisosVariavel = [];
    const achadosPorBuscaDireta = [];

    const lotes = dividirEmLotes(paraProcessar, TAMANHO_LOTE);

    for (let i = 0; i < lotes.length; i++) {
      const lote = lotes[i];
      const payloadCriar = [];
      const payloadAtualizar = [];
      const migracoesDoLote = new Set();

      for (const { produto, sku, skuAntigo, preco, estoque } of lote) {
        // Primeiro tenta achar pelo SKU novo (digito)
        let produtoWoo = mapaProdutosWoo.get(sku.toLowerCase());
        let precisaMigrarSku = false;

        // Se não achou, e existe um SKU antigo possível (referencia),
        // tenta achar por ele - produto já existe, só precisa migrar o SKU
        if (!produtoWoo && skuAntigo) {
          produtoWoo = mapaProdutosWoo.get(skuAntigo.toLowerCase());
          if (produtoWoo) {
            precisaMigrarSku = true;
          }
        }

        // Ainda não achou: antes de criar, pergunta direto ao Woo por esse SKU.
        // Pega produtos que a listagem não trouxe (ex.: SKU gravado com espaço
        // ou caractere invisível), evitando o erro "SKU duplicado".
        if (!produtoWoo) {
          const encontrado = await buscarProdutoPorSku(sku);
          if (encontrado) {
            produtoWoo = encontrado;
            precisaMigrarSku = String(encontrado.sku) !== sku; // regrava o SKU "limpo"
            achadosPorBuscaDireta.push(
              `${sku} (${encontrado.name}): id ${encontrado.id}, status ${encontrado.status}, SKU na loja ${JSON.stringify(encontrado.sku)}`
            );
          }
        }

        if (produtoWoo) {
          // Produto variável: o preço fica nas variações, não no produto pai
          if (produtoWoo.type === 'variable') {
            avisosVariavel.push(`${sku} (${produtoWoo.name}) é variável - preço não é sincronizado`);
            continue;
          }

          const { precoMudou, estoqueMudou, precoAtual } = compararProduto(preco, estoque, produtoWoo);

          // Preço promocional preenchido no Woo "esconde" o preço normal no site
          if (produtoWoo.sale_price && String(produtoWoo.sale_price).trim() !== '') {
            avisosPromocao.push(
              `${sku} (${produtoWoo.name}): site mostra promoção ${produtoWoo.sale_price}, sistema = ${formatarPreco(preco)}`
            );
          }

          if (precisaMigrarSku || precoMudou || estoqueMudou) {
            payloadAtualizar.push(montarPayloadAtualizacao(produtoWoo, preco, estoque, sku, precisaMigrarSku));
            if (precisaMigrarSku) migracoesDoLote.add(produtoWoo.id);
            if (precoMudou) {
              mudancasPreco.push(`${sku} (${produtoWoo.name}): ${formatarPreco(precoAtual)} → ${formatarPreco(preco)}`);
            }
          } else {
            semMudanca++;
          }
        } else {
          payloadCriar.push(montarPayloadCriacao(produto, sku, preco, estoque, mapaGrupos));
        }
      }

      try {
        const resultado = await enviarLote(payloadCriar, payloadAtualizar);

        for (const [idx, item] of (resultado.create || []).entries()) {
          if (item.error) {
            comErro++;
            const enviado = payloadCriar[idx] || {};
            let conflito = '';
            const idConflito = item.error.data?.resource_id;
            if (idConflito) {
              conflito = ` [produto em conflito: id ${idConflito}`;
              try {
                const r = await WooCommerce.get(`products/${idConflito}`, { _fields: 'id,name,sku,status,type,parent_id' });
                conflito += ` - "${r.data.name}", tipo ${r.data.type}, status ${r.data.status}, SKU ${JSON.stringify(r.data.sku)}`;
              } catch (e) {
                conflito += ` - não abre como produto (${e.response?.status || e.message}); pode ser variação ou resto de produto apagado`;
              }
              conflito += ']';
            }
            erros.push(`Criar ${item.sku || enviado.sku || '?'} (${enviado.name || '?'}): ${item.error.message}${conflito}`);
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
            if (migracoesDoLote.has(item.id)) migrados++;
          }
        }

        console.log(`📦 Lote ${i + 1}/${lotes.length} enviado (${payloadCriar.length} criar, ${payloadAtualizar.length} atualizar)`);
      } catch (erroLote) {
        comErro += payloadCriar.length + payloadAtualizar.length;
        const detalhe = erroLote.response?.data?.message || erroLote.message;
        erros.push(`Lote ${i + 1} falhou inteiro: ${detalhe}`);
        console.log(`❌ Erro no lote ${i + 1}: ${detalhe}`);
      }
    }

    const duracao = Math.round((Date.now() - inicio) / 1000);
    console.log(`\n--- Sincronização concluída em ${duracao}s ---`);
    console.log(
      `Criados: ${criados} | Atualizados: ${atualizados} (${migrados} migraram SKU de referência p/ digito) | ` +
        `Sem mudança: ${semMudanca} | Ignorados: ${ignorados} | Pulados (sem identificador): ${semIdentificador} | ` +
        `Sem preço válido: ${semPreco.length} | SKU duplicado (pulados): ${skuDuplicado.length} | Com erro: ${comErro}`
    );

    imprimirLista('🚫 SKU repetido no sistema - pulados (corrigir o campo "digito" no Pixcell)', skuDuplicado);

    imprimirLista('🔍 Produtos que a listagem não trouxe, mas existem na loja (achados por busca direta)', achadosPorBuscaDireta);
    imprimirLista('💲 Preços alterados', mudancasPreco);
    imprimirLista('⚠️  Produtos com preço promocional no Woo (o site mostra a promoção, não o preço do sistema)', avisosPromocao);
    imprimirLista('⚠️  Produtos variáveis (não sincronizados)', avisosVariavel);
    imprimirLista('⚠️  Produtos sem preço válido no sistema (não enviados)', semPreco);
    imprimirLista('❌ Erros', erros);

    return comErro === 0;
  } finally {
    await connection.end();
  }
}

// Código de saída diferente de 0 faz o GitHub Actions marcar a execução
// como FALHA (vermelho) e mandar e-mail - antes, erro aparecia como sucesso.
sincronizar()
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch((erro) => {
    console.error('❌ Erro geral durante a sincronização:', erro.message);
    process.exitCode = 1;
  });
