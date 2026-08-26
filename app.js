/* ==========================================================================
   Painel Regulação RS — app.js  (v2)
   Site estático (sem build). Consome os JSON/GeoJSON em ./dados/.
   Gerados por prep_dados_dashboard.py a partir da extração do robô Power BI
   + mapa_saude_rs.gpkg (ver README.md para regenerar mensalmente).

   Mudanças desta versão (pedidos da Marta em 21/08/2026):
   - Mapas ganharam camada de tiles OpenStreetMap (antes ficavam em branco,
     só com os polígonos, sem nenhum fundo geográfico real).
   - Série histórica de Central de Regulação ganhou a linha "Total" (o dado
     já existia no JSON, só não estava sendo plotado).
   - Rankings por Especialidade Mãe / Sub Especialidade agora mostram TODAS
     as categorias (antes cortava em top 12), com scroll no lugar do corte.
   - Nova seção de Taxa de crescimento populacional por 1.000 habitantes
     (‰), agregável por região/macrorregião, 2023→2024 e 2024→2025.
   - Todo gráfico ganhou botão de expandir (modal) e baixar como PNG.
   - Botão "Exportar PDF" (via impressão do navegador) com banner de filtro
     ativo sempre visível, inclusive no PDF gerado.
   ========================================================================== */

const CAMPO_MUN = "nome_municipio";
const CAMPO_REGIAO = "Região de Saúde";
const CAMPO_MACRO = "Macrorregião de Saúde";

const MESES_ORDEM = { jan:1, fev:2, mar:3, abr:4, mai:5, jun:6, jul:7, ago:8, set:9, out:10, nov:11, dez:12 };

const PALETA = ["#134e79","#e07b28","#2e9e5b","#c1443c","#5fa8d3","#8b5cf6","#0e7490","#a16207","#be185d","#4d7c0f"];

const RAMP_FILA   = ["#fff2cc","#ffd966","#f6b26b","#e07b28","#c1443c","#8b1e1e"];
const RAMP_POP     = ["#e8f3fa","#bcdff0","#8cc7e3","#5fa8d3","#2f7fb0","#134e79"];
const RAMP_DIVERGENTE = ["#c1443c","#e59389","#f4d9d5","#dfeee2","#8fc79e","#2e9e5b"];

const ALTURA_POR_BARRA = 22; // px por barra nos rankings roláveis
const ALTURA_MIN_GRAFICO = 260;

const estado = {
  filtros: { macrorregiao: "", regiao: "", municipio: "" },
  dados: {},
  mapas: {},      // instâncias leaflet
  camadas: {},    // geojson layers
  graficos: {},   // instâncias chart.js
  graficoModal: null,
  ordenacao: {},  // estado de ordenação das tabelas
};

// -------------------------------------------------------------------------
// utilidades
// -------------------------------------------------------------------------
function fmtN(n, casas = 0) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
}
function fmtPct(n, casas = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sinal = n > 0 ? "+" : "";
  return `${sinal}${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}%`;
}
function fmtPermil(n, casas = 2) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const sinal = n > 0 ? "+" : "";
  return `${sinal}${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas })}‰`;
}
function numOuNulo(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (s === "" || s === '""' || s.toLowerCase() === "nan") return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}
async function carregarJSON(caminho) {
  const resp = await fetch(caminho);
  if (!resp.ok) throw new Error(`Falha ao carregar ${caminho}: ${resp.status}`);
  return resp.json();
}
function ordenarMesAno(a, b) {
  // "ago/2023" -> compara ano, depois mês
  const [ma, ya] = a.split("/");
  const [mb, yb] = b.split("/");
  if (ya !== yb) return Number(ya) - Number(yb);
  return (MESES_ORDEM[ma] || 0) - (MESES_ORDEM[mb] || 0);
}
function mediaMovel(valores, janela = 3) {
  return valores.map((_, i) => {
    const ini = Math.max(0, i - janela + 1);
    const fatia = valores.slice(ini, i + 1).filter((v) => v !== null && v !== undefined);
    if (!fatia.length) return null;
    return fatia.reduce((a, b) => a + b, 0) / fatia.length;
  });
}
function quantis(valores, n) {
  const v = valores.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return [];
  const cortes = [];
  for (let i = 1; i < n; i++) {
    const idx = Math.floor((i / n) * (v.length - 1));
    cortes.push(v[idx]);
  }
  return cortes;
}
function corSequencial(valor, cortes, paleta) {
  if (valor === null || valor === undefined || Number.isNaN(valor)) return "#d9dfe6";
  let i = 0;
  while (i < cortes.length && valor > cortes[i]) i++;
  return paleta[Math.min(i, paleta.length - 1)];
}
function corDivergente(valor, maxAbs, paleta) {
  if (valor === null || valor === undefined || Number.isNaN(valor)) return "#d9dfe6";
  const meio = (paleta.length - 1) / 2;
  const pos = meio + (valor / (maxAbs || 1)) * meio;
  const i = Math.max(0, Math.min(paleta.length - 1, Math.round(pos)));
  return paleta[i];
}

// -------------------------------------------------------------------------
// carregamento inicial
// -------------------------------------------------------------------------
async function iniciar() {
  const base = "dados/";
  const [
    meta, municipiosGeo, rankEsp, rankSub, tempoMediano,
    histEsp, histCentral, popMacro, popRegiao,
  ] = await Promise.all([
    carregarJSON(base + "meta.json"),
    carregarJSON(base + "municipios.geojson"),
    carregarJSON(base + "ranking_especialidade_por_mun.json"),
    carregarJSON(base + "ranking_subespecialidade_por_mun.json"),
    carregarJSON(base + "tempo_mediano_subespecialidade.json"),
    carregarJSON(base + "historico_especialidade_mae.json"),
    carregarJSON(base + "historico_central_regulacao.json"),
    carregarJSON(base + "populacao_por_macrorregiao.json"),
    carregarJSON(base + "populacao_por_regiao_saude.json"),
  ]);

  estado.dados = { meta, municipiosGeo, rankEsp, rankSub, tempoMediano, histEsp, histCentral, popMacro, popRegiao };

  preencherMeta();
  montarFiltros();
  montarAbas();
  montarMapaFila();
  montarMapaPopulacao();
  montarSeletorHistorico();
  montarFerramentasGrafico();
  montarExportarPdf();
  document.getElementById("busca-tempo-mediano").addEventListener("input", () => renderTabelaTempoMediano());
  document.getElementById("mapa-fila-metrica").addEventListener("change", () => atualizarCamadaFila());
  document.getElementById("mapa-pop-metrica").addEventListener("change", () => atualizarCamadaPopulacao());
  document.getElementById("pop-agrupamento").addEventListener("change", () => renderGraficoPopRegiao());
  document.getElementById("taxa-agrupamento").addEventListener("change", () => renderGraficoTaxaCrescimento());
  document.getElementById("hist-especialidade").addEventListener("change", () => renderGraficoHistoricoEspecialidade());
  document.getElementById("btn-limpar-filtros").addEventListener("click", limparFiltros);

  atualizarTudo();
  document.getElementById("carregando").classList.add("oculto");
}

function preencherMeta() {
  const m = estado.dados.meta;
  document.getElementById("meta-data-fila").textContent = m.data_extracao_fila || "—";
  document.getElementById("meta-data-geracao").textContent = m.gerado_em || "—";
  document.getElementById("meta-n-municipios").textContent = m.municipios ?? "—";
  document.getElementById("sobre-data-fila").textContent = m.data_extracao_fila || "—";
  document.getElementById("sobre-data-geracao").textContent = m.gerado_em || "—";
}

// -------------------------------------------------------------------------
// filtros (macrorregião → região → município), com cascata nos dois sentidos
// -------------------------------------------------------------------------
function montarFiltros() {
  const feats = estado.dados.municipiosGeo.features.map((f) => f.properties);

  const macros = [...new Set(feats.map((p) => p[CAMPO_MACRO]).filter(Boolean))].sort();
  const selMacro = document.getElementById("f-macrorregiao");
  macros.forEach((m) => selMacro.append(new Option(m, m)));

  const datalist = document.getElementById("lista-municipios");
  feats
    .map((p) => p[CAMPO_MUN])
    .sort((a, b) => a.localeCompare(b, "pt-BR"))
    .forEach((n) => datalist.append(new Option(n, n)));

  preencherRegioes();

  selMacro.addEventListener("change", () => {
    estado.filtros.macrorregiao = selMacro.value;
    // se a região atual não pertence à nova macro, limpa
    const regiaoValida = feats.some(
      (p) => p[CAMPO_REGIAO] === estado.filtros.regiao && (!selMacro.value || p[CAMPO_MACRO] === selMacro.value)
    );
    if (!regiaoValida) estado.filtros.regiao = "";
    preencherRegioes();
    document.getElementById("f-regiao").value = estado.filtros.regiao;
    estado.filtros.municipio = validarMunicipioContraFiltro();
    document.getElementById("f-municipio").value = estado.filtros.municipio;
    atualizarTudo();
  });

  document.getElementById("f-regiao").addEventListener("change", (e) => {
    estado.filtros.regiao = e.target.value;
    estado.filtros.municipio = validarMunicipioContraFiltro();
    document.getElementById("f-municipio").value = estado.filtros.municipio;
    atualizarTudo();
  });

  document.getElementById("f-municipio").addEventListener("change", (e) => {
    const nome = e.target.value.trim();
    const feat = feats.find((p) => p[CAMPO_MUN].toLowerCase() === nome.toLowerCase());
    if (!feat) {
      if (nome === "") { estado.filtros.municipio = ""; atualizarTudo(); }
      return;
    }
    estado.filtros.municipio = feat[CAMPO_MUN];
    estado.filtros.regiao = feat[CAMPO_REGIAO];
    estado.filtros.macrorregiao = feat[CAMPO_MACRO];
    document.getElementById("f-macrorregiao").value = estado.filtros.macrorregiao;
    preencherRegioes();
    document.getElementById("f-regiao").value = estado.filtros.regiao;
    atualizarTudo();
  });
}

function preencherRegioes() {
  const feats = estado.dados.municipiosGeo.features.map((f) => f.properties);
  const macro = estado.filtros.macrorregiao;
  const regioes = [...new Set(
    feats.filter((p) => !macro || p[CAMPO_MACRO] === macro).map((p) => p[CAMPO_REGIAO]).filter(Boolean)
  )].sort();
  const sel = document.getElementById("f-regiao");
  sel.innerHTML = '<option value="">Todas</option>';
  regioes.forEach((r) => sel.append(new Option(r.trim(), r)));
}

function validarMunicipioContraFiltro() {
  if (!estado.filtros.municipio) return "";
  const feats = estado.dados.municipiosGeo.features.map((f) => f.properties);
  const feat = feats.find((p) => p[CAMPO_MUN] === estado.filtros.municipio);
  if (!feat) return "";
  const okMacro = !estado.filtros.macrorregiao || feat[CAMPO_MACRO] === estado.filtros.macrorregiao;
  const okRegiao = !estado.filtros.regiao || feat[CAMPO_REGIAO] === estado.filtros.regiao;
  return okMacro && okRegiao ? estado.filtros.municipio : "";
}

function limparFiltros() {
  estado.filtros = { macrorregiao: "", regiao: "", municipio: "" };
  document.getElementById("f-macrorregiao").value = "";
  preencherRegioes();
  document.getElementById("f-regiao").value = "";
  document.getElementById("f-municipio").value = "";
  atualizarTudo();
}

function municipiosNoFiltro() {
  const feats = estado.dados.municipiosGeo.features;
  return feats.filter((f) => {
    const p = f.properties;
    if (estado.filtros.municipio) return p[CAMPO_MUN] === estado.filtros.municipio;
    if (estado.filtros.regiao) return p[CAMPO_REGIAO] === estado.filtros.regiao;
    if (estado.filtros.macrorregiao) return p[CAMPO_MACRO] === estado.filtros.macrorregiao;
    return true;
  });
}

// -------------------------------------------------------------------------
// abas
// -------------------------------------------------------------------------
function montarAbas() {
  document.querySelectorAll("nav.abas button").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("nav.abas button").forEach((b) => b.classList.remove("ativa"));
      document.querySelectorAll("main .secao").forEach((s) => s.classList.remove("ativa"));
      btn.classList.add("ativa");
      document.getElementById(btn.dataset.secao).classList.add("ativa");
      const ehSobre = btn.dataset.secao === "secao-sobre";
      document.getElementById("barra-filtros").style.display = ehSobre ? "none" : "flex";
      document.getElementById("filtro-atual-banner").style.display = ehSobre ? "none" : "block";
      setTimeout(() => {
        if (estado.mapas.fila) estado.mapas.fila.invalidateSize();
        if (estado.mapas.pop) estado.mapas.pop.invalidateSize();
      }, 50);
    });
  });
}

// -------------------------------------------------------------------------
// atualização geral (chamada sempre que um filtro muda)
// -------------------------------------------------------------------------
function atualizarTudo() {
  renderChipsFiltro();
  renderKpisFila();
  atualizarCamadaFila();
  renderTabelaRankingMunicipios();
  renderGraficoRankEspecialidade();
  renderGraficoRankSubespecialidade();

  renderKpisPopulacao();
  atualizarCamadaPopulacao();
  renderTabelaRankingCrescimento();
  renderGraficoPopRegiao();
  renderGraficoPopEvolucao();
  renderGraficoTaxaCrescimento();
}

function rotuloFiltroAtual() {
  return estado.filtros.municipio
    ? `Município: ${estado.filtros.municipio}`
    : estado.filtros.regiao
    ? `Região: ${estado.filtros.regiao.trim()}`
    : estado.filtros.macrorregiao
    ? `Macrorregião: ${estado.filtros.macrorregiao}`
    : "Estado inteiro (RS)";
}

function renderChipsFiltro() {
  // atualiza os sub-títulos que dizem "estado inteiro" vs município
  const rotulo = rotuloFiltroAtual();
  document.getElementById("rank-esp-sub").textContent = `${rotulo} · Especialidade Mãe · todas as categorias, role para ver mais`;
  document.getElementById("rank-sub-sub").textContent = `${rotulo} · Sub Especialidade · todas as categorias, role para ver mais`;
  document.getElementById("ranking-mun-sub").textContent = rotulo;
  document.getElementById("kpi-fila-total-nota").textContent = rotulo;
  document.getElementById("filtro-atual-banner").textContent = `Filtro atual: ${rotulo}`;
}

// -------------------------------------------------------------------------
// FILA DE ESPERA — KPIs
// -------------------------------------------------------------------------
function renderKpisFila() {
  const feats = municipiosNoFiltro();
  const total = feats.reduce((s, f) => s + (numOuNulo(f.properties["Total Geral da Lista de Espera"]) || 0), 0);
  const total60 = feats.reduce((s, f) => s + (numOuNulo(f.properties["Total Geral da Lista de Espera 60+"]) || 0), 0);
  const estadual = feats.reduce((s, f) => s + (numOuNulo(f.properties["Total Centrais de Reg Estadual"]) || 0), 0);
  const municipal = feats.reduce((s, f) => s + (numOuNulo(f.properties["Total Centrais de Reg Municipal"]) || 0), 0);
  const regional = feats.reduce((s, f) => s + (numOuNulo(f.properties["Total Centrais de Reg Regional"]) || 0), 0);

  document.getElementById("kpi-fila-total").textContent = fmtN(total);
  document.getElementById("kpi-fila-60").textContent = fmtN(total60);
  document.getElementById("kpi-fila-60-nota").textContent = total ? `${fmtPct((total60 / total) * 100).replace("+", "")} do total` : "—";
  document.getElementById("kpi-fila-nmun").textContent = feats.length;

  const central = [["Estadual", estadual], ["Municipal", municipal], ["Regional", regional]].sort((a, b) => b[1] - a[1])[0];
  document.getElementById("kpi-fila-central").textContent = `${central[0]} (${fmtN(central[1])})`;
}

// -------------------------------------------------------------------------
// MAPA — fila de espera
// -------------------------------------------------------------------------
function adicionarCamadaBase(mapa) {
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> colaboradores',
    maxZoom: 18,
  }).addTo(mapa);
}
function montarMapaFila() {
  const mapa = L.map("mapa", { scrollWheelZoom: false }).setView([-29.3, -53.2], 6.4);
  estado.mapas.fila = mapa;
  adicionarCamadaBase(mapa);
  const camada = L.geoJSON(estado.dados.municipiosGeo, {
    style: () => estiloPadrao(),
    onEachFeature: (feature, layer) => {
      layer.on("click", () => {
        estado.filtros.municipio = feature.properties[CAMPO_MUN];
        estado.filtros.regiao = feature.properties[CAMPO_REGIAO];
        estado.filtros.macrorregiao = feature.properties[CAMPO_MACRO];
        document.getElementById("f-municipio").value = estado.filtros.municipio;
        document.getElementById("f-macrorregiao").value = estado.filtros.macrorregiao;
        preencherRegioes();
        document.getElementById("f-regiao").value = estado.filtros.regiao;
        atualizarTudo();
      });
      layer.on("mouseover", () => layer.setStyle({ weight: 2, color: "#0b2e4f" }));
      layer.on("mouseout", () => camada.resetStyle(layer));
    },
  }).addTo(mapa);
  estado.camadas.fila = camada;
  atualizarCamadaFila();
}
function estiloPadrao() {
  return { fillColor: "#d9dfe6", weight: 0.6, color: "#ffffff", fillOpacity: 0.75 };
}
function atualizarCamadaFila() {
  if (!estado.camadas.fila) return;
  const metrica = document.getElementById("mapa-fila-metrica").value;
  const todosValores = estado.dados.municipiosGeo.features.map((f) => numOuNulo(f.properties[metrica]));
  const cortes = quantis(todosValores, RAMP_FILA.length);
  const escopo = new Set(municipiosNoFiltro().map((f) => f.properties[CAMPO_MUN]));
  const emFiltro = escopo.size < estado.dados.municipiosGeo.features.length;

  estado.camadas.fila.eachLayer((layer) => {
    const p = layer.feature.properties;
    const noFiltro = !emFiltro || escopo.has(p[CAMPO_MUN]);
    const cor = noFiltro ? corSequencial(numOuNulo(p[metrica]), cortes, RAMP_FILA) : "#eef1f4";
    layer.setStyle({ fillColor: cor, fillOpacity: noFiltro ? 0.78 : 0.25, weight: 0.6, color: "#fff" });
    const rotuloMetrica = document.getElementById("mapa-fila-metrica").selectedOptions[0].text;
    layer.bindTooltip(
      `<div class="tooltip-municipio"><b>${p[CAMPO_MUN]}</b><br>${rotuloMetrica}: ${fmtN(numOuNulo(p[metrica]))}<br>${p[CAMPO_REGIAO] ? p[CAMPO_REGIAO].trim() : ""}</div>`,
      { sticky: true }
    );
  });
  renderLegenda("legenda-mapa-fila", cortes, RAMP_FILA);
}
function renderLegenda(idEl, cortes, paleta) {
  const el = document.getElementById(idEl);
  if (!cortes.length) { el.innerHTML = ""; return; }
  const faixas = [Math.min(...cortes), ...cortes];
  el.innerHTML =
    `<span>${fmtN(faixas[0])}</span>` +
    `<span class="legenda-escala">${paleta.map((c) => `<span style="background:${c}"></span>`).join("")}</span>` +
    `<span>${fmtN(cortes[cortes.length - 1])}+</span>`;
}

// -------------------------------------------------------------------------
// MAPA — população
// -------------------------------------------------------------------------
function montarMapaPopulacao() {
  const mapa = L.map("mapa-pop", { scrollWheelZoom: false }).setView([-29.3, -53.2], 6.4);
  estado.mapas.pop = mapa;
  adicionarCamadaBase(mapa);
  const camada = L.geoJSON(estado.dados.municipiosGeo, {
    style: () => estiloPadrao(),
    onEachFeature: (feature, layer) => {
      layer.on("mouseover", () => layer.setStyle({ weight: 2, color: "#0b2e4f" }));
      layer.on("mouseout", () => camada.resetStyle(layer));
    },
  }).addTo(mapa);
  estado.camadas.pop = camada;
  atualizarCamadaPopulacao();
}
function atualizarCamadaPopulacao() {
  if (!estado.camadas.pop) return;
  const metrica = document.getElementById("mapa-pop-metrica").value;
  const divergente = metrica === "crescimento_23_25_pct";
  const todosValores = estado.dados.municipiosGeo.features.map((f) => numOuNulo(f.properties[metrica]));
  const maxAbs = Math.max(...todosValores.map((v) => Math.abs(v || 0)));
  const cortes = divergente ? [] : quantis(todosValores, RAMP_POP.length);
  const escopo = new Set(municipiosNoFiltro().map((f) => f.properties[CAMPO_MUN]));
  const emFiltro = escopo.size < estado.dados.municipiosGeo.features.length;
  const rotuloMetrica = document.getElementById("mapa-pop-metrica").selectedOptions[0].text;

  estado.camadas.pop.eachLayer((layer) => {
    const p = layer.feature.properties;
    const v = numOuNulo(p[metrica]);
    const noFiltro = !emFiltro || escopo.has(p[CAMPO_MUN]);
    const cor = !noFiltro ? "#eef1f4" : divergente ? corDivergente(v, maxAbs, RAMP_DIVERGENTE) : corSequencial(v, cortes, RAMP_POP);
    layer.setStyle({ fillColor: cor, fillOpacity: noFiltro ? 0.78 : 0.25, weight: 0.6, color: "#fff" });
    layer.bindTooltip(
      `<div class="tooltip-municipio"><b>${p[CAMPO_MUN]}</b><br>${rotuloMetrica}: ${metrica === "crescimento_23_25_pct" ? fmtPct(v) : fmtN(v)}<br>${p[CAMPO_REGIAO] ? p[CAMPO_REGIAO].trim() : ""}</div>`,
      { sticky: true }
    );
  });
  if (divergente) {
    document.getElementById("legenda-mapa-pop").innerHTML =
      `<span>${fmtPct(-maxAbs)}</span><span class="legenda-escala">${RAMP_DIVERGENTE.map((c) => `<span style="background:${c}"></span>`).join("")}</span><span>${fmtPct(maxAbs)}</span>`;
  } else {
    renderLegenda("legenda-mapa-pop", cortes, RAMP_POP);
  }
}

// -------------------------------------------------------------------------
// tabelas genéricas (ordenáveis)
// -------------------------------------------------------------------------
function renderTabelaGenerica(idTabela, linhas, colunas) {
  const tabela = document.getElementById(idTabela);
  const tbody = tabela.querySelector("tbody");
  const ordAtual = estado.ordenacao[idTabela] || { col: colunas[colunas.length - 1].chave, dir: -1 };
  estado.ordenacao[idTabela] = ordAtual;

  const linhasOrdenadas = [...linhas].sort((a, b) => {
    const va = a[ordAtual.col], vb = b[ordAtual.col];
    if (typeof va === "string") return va.localeCompare(vb, "pt-BR") * ordAtual.dir;
    return ((va ?? -Infinity) - (vb ?? -Infinity)) * ordAtual.dir;
  });

  if (!linhasOrdenadas.length) {
    tbody.innerHTML = `<tr><td colspan="${colunas.length}" class="aviso-vazio">Sem dados para este filtro</td></tr>`;
  } else {
    tbody.innerHTML = linhasOrdenadas
      .slice(0, 30)
      .map((r) => `<tr>${colunas.map((c) => `<td>${c.fmt ? c.fmt(r[c.chave]) : r[c.chave]}</td>`).join("")}</tr>`)
      .join("");
  }

  tabela.querySelectorAll("th[data-col]").forEach((th) => {
    th.onclick = () => {
      const col = th.dataset.col;
      const chaveReal = colunas.find((c) => c.rotuloCol === col)?.chave || col;
      if (ordAtual.col === chaveReal) ordAtual.dir *= -1;
      else { ordAtual.col = chaveReal; ordAtual.dir = -1; }
      renderTabelaGenerica(idTabela, linhas, colunas);
    };
  });
}

function renderTabelaRankingMunicipios() {
  const linhas = municipiosNoFiltro().map((f) => ({
    nome: f.properties[CAMPO_MUN],
    total: numOuNulo(f.properties["Total Geral da Lista de Espera"]) || 0,
    p60: numOuNulo(f.properties["Total Geral da Lista de Espera 60+"]) || 0,
  }));
  renderTabelaGenerica("tabela-ranking-municipios", linhas, [
    { chave: "nome", rotuloCol: "nome" },
    { chave: "total", rotuloCol: "total", fmt: fmtN },
    { chave: "p60", rotuloCol: "p60", fmt: fmtN },
  ]);
}

function renderTabelaRankingCrescimento() {
  const linhas = municipiosNoFiltro().map((f) => ({
    nome: f.properties[CAMPO_MUN],
    pop: numOuNulo(f.properties.pop_2025) || 0,
    cresc: numOuNulo(f.properties.crescimento_23_25_pct),
  }));
  renderTabelaGenerica("tabela-ranking-crescimento", linhas, [
    { chave: "nome", rotuloCol: "nome" },
    { chave: "pop", rotuloCol: "pop", fmt: fmtN },
    { chave: "cresc", rotuloCol: "cresc", fmt: fmtPct },
  ]);
}

function renderTabelaTempoMediano() {
  const busca = document.getElementById("busca-tempo-mediano").value.trim().toLowerCase();
  const linhas = estado.dados.tempoMediano
    .filter((r) => !busca || r.sub_especialidade.toLowerCase().includes(busca))
    .map((r) => ({
      nome: r.sub_especialidade,
      geral: numOuNulo(r["Tempo Mediano na Lista de Espera Geral (dias)"]),
      p60: numOuNulo(r["Tempo Mediano na Lista de Espera 60+ (dias)"]),
    }));
  const tabela = document.getElementById("tabela-tempo-mediano");
  const ord = estado.ordenacao["tabela-tempo-mediano"] || { col: "geral", dir: -1 };
  estado.ordenacao["tabela-tempo-mediano"] = ord;
  const ordenado = [...linhas].sort((a, b) => {
    const va = a[ord.col], vb = b[ord.col];
    if (typeof va === "string") return va.localeCompare(vb, "pt-BR") * ord.dir;
    return ((va ?? -Infinity) - (vb ?? -Infinity)) * ord.dir;
  });
  const tbody = tabela.querySelector("tbody");
  tbody.innerHTML = ordenado.length
    ? ordenado.map((r) => `<tr><td>${r.nome}</td><td>${fmtN(r.geral)}</td><td>${fmtN(r.p60)}</td></tr>`).join("")
    : `<tr><td colspan="3" class="aviso-vazio">Nenhuma sub especialidade encontrada</td></tr>`;
  tabela.querySelectorAll("th[data-col]").forEach((th) => {
    th.onclick = () => {
      const mapaCol = { nome: "nome", geral: "geral", p60: "p60" };
      const col = mapaCol[th.dataset.col];
      if (ord.col === col) ord.dir *= -1; else { ord.col = col; ord.dir = -1; }
      renderTabelaTempoMediano();
    };
  });
}

// -------------------------------------------------------------------------
// gráficos — rankings por especialidade / sub especialidade
// -------------------------------------------------------------------------
function agregarRanking(dicionario, campoCategoria) {
  // v2: não corta mais em top N — devolve TODAS as categorias com total > 0,
  // ordenadas do maior para o menor. O painel usa scroll pra mostrar tudo.
  const escopo = municipiosNoFiltro().map((f) => f.properties[CAMPO_MUN]);
  const soma = {};
  escopo.forEach((mun) => {
    (dicionario[mun] || []).forEach((item) => {
      const cat = item[campoCategoria];
      soma[cat] = (soma[cat] || 0) + (numOuNulo(item.Total_Fila) || 0);
    });
  });
  return Object.entries(soma)
    .filter(([, total]) => total > 0)
    .sort((a, b) => b[1] - a[1]);
}
function graficoBarraHorizontal(idCanvas, pares, cor) {
  const canvas = document.getElementById(idCanvas);
  // altura dinâmica: uma barra legível por categoria, com um mínimo pra não
  // ficar minúsculo quando há poucas categorias no filtro atual.
  const altura = Math.max(ALTURA_MIN_GRAFICO, pares.length * ALTURA_POR_BARRA);
  canvas.parentElement.style.height = `${altura}px`;
  if (estado.graficos[idCanvas]) estado.graficos[idCanvas].destroy();
  estado.graficos[idCanvas] = new Chart(canvas, {
    type: "bar",
    data: {
      labels: pares.map((p) => p[0]),
      datasets: [{ label: "Total na fila", data: pares.map((p) => p[1]), backgroundColor: cor, borderRadius: 4 }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${fmtN(c.raw)}` } } },
      scales: { x: { ticks: { callback: (v) => fmtN(v) } } },
    },
  });
}
function renderGraficoRankEspecialidade() {
  const pares = agregarRanking(estado.dados.rankEsp, "EspecialidadeMae");
  graficoBarraHorizontal("grafico-rank-especialidade", pares, "#134e79");
}
function renderGraficoRankSubespecialidade() {
  const pares = agregarRanking(estado.dados.rankSub, "SubEspecialidade");
  graficoBarraHorizontal("grafico-rank-subespecialidade", pares, "#e07b28");
}

// -------------------------------------------------------------------------
// gráficos — séries históricas (estaduais, não filtram por município)
// -------------------------------------------------------------------------
function montarSeletorHistorico() {
  const categorias = [...new Set(estado.dados.histEsp.map((r) => r.EspecialidadeMae))].sort();
  const sel = document.getElementById("hist-especialidade");
  categorias.forEach((c) => sel.append(new Option(c, c)));
  if (categorias.includes("OFTALMOLOGIA")) sel.value = "OFTALMOLOGIA";
  renderGraficoHistoricoEspecialidade();
  renderGraficoHistoricoCentral();
}
function renderGraficoHistoricoEspecialidade() {
  const categoria = document.getElementById("hist-especialidade").value;
  const linhas = estado.dados.histEsp
    .filter((r) => r.EspecialidadeMae === categoria)
    .sort((a, b) => ordenarMesAno(a["Mes Ano Abrev"], b["Mes Ano Abrev"]));
  const labels = linhas.map((r) => r["Mes Ano Abrev"]);
  const valores = linhas.map((r) => numOuNulo(r["Fila Top 6 Especialidades_FiltroPeriodo"]));
  const tendencia = mediaMovel(valores, 3);

  const ctx = document.getElementById("grafico-historico-especialidade");
  if (estado.graficos.histEsp) estado.graficos.histEsp.destroy();
  estado.graficos.histEsp = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: categoria, data: valores, borderColor: "#134e79", backgroundColor: "#134e7922", fill: true, tension: 0.25, pointRadius: 2 },
        { label: "Tendência (média móvel 3m)", data: tendencia, borderColor: "#e07b28", borderDash: [6, 4], pointRadius: 0, tension: 0.25 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtN(c.raw)}` } } },
      scales: { x: { ticks: { maxRotation: 60, minRotation: 60 } }, y: { ticks: { callback: (v) => fmtN(v) } } },
    },
  });
}
function renderGraficoHistoricoCentral() {
  const linhas = [...estado.dados.histCentral].sort((a, b) => ordenarMesAno(a["Mes Ano Abrev"], b["Mes Ano Abrev"]));
  const labels = linhas.map((r) => r["Mes Ano Abrev"]);
  const ctx = document.getElementById("grafico-historico-central");
  if (estado.graficos.histCentral) estado.graficos.histCentral.destroy();
  estado.graficos.histCentral = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Total", data: linhas.map((r) => numOuNulo(r["Total Fila de Espera"])), borderColor: "#1c2530", borderWidth: 3, tension: 0.25, pointRadius: 2 },
        { label: "Estadual", data: linhas.map((r) => numOuNulo(r["Total Estadual"])), borderColor: PALETA[0], tension: 0.25, pointRadius: 2 },
        { label: "Municipal", data: linhas.map((r) => numOuNulo(r["Total Municipal"])), borderColor: PALETA[1], tension: 0.25, pointRadius: 2 },
        { label: "Regional", data: linhas.map((r) => numOuNulo(r["Total Regional"])), borderColor: PALETA[2], tension: 0.25, pointRadius: 2 },
      ],
    },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtN(c.raw)}` } } },
      scales: { x: { ticks: { maxRotation: 60, minRotation: 60 } }, y: { ticks: { callback: (v) => fmtN(v) } } },
    },
  });
}

// -------------------------------------------------------------------------
// POPULAÇÃO — KPIs e gráficos
// -------------------------------------------------------------------------
function renderKpisPopulacao() {
  const feats = municipiosNoFiltro();
  const p23 = feats.reduce((s, f) => s + (numOuNulo(f.properties.pop_2023) || 0), 0);
  const p25 = feats.reduce((s, f) => s + (numOuNulo(f.properties.pop_2025) || 0), 0);
  const area = feats.reduce((s, f) => s + (numOuNulo(f.properties.AREA_KM2) || 0), 0);
  document.getElementById("kpi-pop-2025").textContent = fmtN(p25);
  document.getElementById("kpi-pop-2025-nota").textContent = rotuloFiltroAtual();
  document.getElementById("kpi-pop-cresc").textContent = p23 ? fmtPct(((p25 - p23) / p23) * 100) : "—";
  document.getElementById("kpi-pop-densidade").textContent = area ? fmtN(p25 / area, 1) : "—";
  document.getElementById("kpi-pop-area").textContent = fmtN(area);
}

function renderGraficoPopRegiao() {
  const agrup = document.getElementById("pop-agrupamento").value;
  const dados = agrup === "macrorregiao" ? estado.dados.popMacro : estado.dados.popRegiao;
  const campo = agrup === "macrorregiao" ? CAMPO_MACRO : CAMPO_REGIAO;
  const ordenado = [...dados].sort((a, b) => b.pop_2025 - a.pop_2025);
  const selecionado = agrup === "macrorregiao" ? estado.filtros.macrorregiao : estado.filtros.regiao;

  const ctx = document.getElementById("grafico-pop-regiao");
  if (estado.graficos.popRegiao) estado.graficos.popRegiao.destroy();
  estado.graficos.popRegiao = new Chart(ctx, {
    type: "bar",
    data: {
      labels: ordenado.map((r) => (r[campo] || "").trim()),
      datasets: [{
        label: "População 2025",
        data: ordenado.map((r) => r.pop_2025),
        backgroundColor: ordenado.map((r) => (selecionado && r[campo] === selecionado ? "#e07b28" : "#5fa8d3")),
        borderRadius: 4,
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${fmtN(c.raw)} hab.` } } },
      scales: { x: { ticks: { callback: (v) => fmtN(v) } } },
    },
  });
}

function renderGraficoPopEvolucao() {
  const dados = estado.dados.popMacro;
  const labels = ["2023", "2024", "2025"];
  const totalRS = [0, 0, 0];
  const datasets = dados.map((r, i) => {
    totalRS[0] += r.pop_2023; totalRS[1] += r.pop_2024; totalRS[2] += r.pop_2025;
    return {
      label: r[CAMPO_MACRO],
      data: [r.pop_2023, r.pop_2024, r.pop_2025],
      borderColor: PALETA[i % PALETA.length],
      backgroundColor: "transparent",
      tension: 0.2,
      pointRadius: 3,
    };
  });
  datasets.push({
    label: "Total RS (tendência)",
    data: totalRS,
    borderColor: "#1c2530",
    borderDash: [6, 4],
    pointRadius: 0,
    yAxisID: "yTotal",
  });

  const ctx = document.getElementById("grafico-pop-evolucao");
  if (estado.graficos.popEvolucao) estado.graficos.popEvolucao.destroy();
  estado.graficos.popEvolucao = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      interaction: { mode: "index", intersect: false },
      plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtN(c.raw)}` } } },
      scales: {
        y: { ticks: { callback: (v) => fmtN(v) } },
        yTotal: { position: "right", ticks: { callback: (v) => fmtN(v) }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

// Taxa de crescimento populacional por 1.000 habitantes (‰), por período,
// agregável por região ou macrorregião de saúde. Calculada a partir da
// própria população de cada nível (já soma os municípios do grupo).
function calcularTaxasPermil(lista, campo) {
  return lista
    .map((r) => {
      const t2324 = r.pop_2023 ? ((r.pop_2024 - r.pop_2023) / r.pop_2023) * 1000 : null;
      const t2425 = r.pop_2024 ? ((r.pop_2025 - r.pop_2024) / r.pop_2024) * 1000 : null;
      return { nome: (r[campo] || "").trim(), t2324, t2425 };
    })
    .sort((a, b) => (b.t2425 ?? -Infinity) - (a.t2425 ?? -Infinity));
}
function renderGraficoTaxaCrescimento() {
  const agrup = document.getElementById("taxa-agrupamento").value;
  const dados = agrup === "macrorregiao" ? estado.dados.popMacro : estado.dados.popRegiao;
  const campo = agrup === "macrorregiao" ? CAMPO_MACRO : CAMPO_REGIAO;
  const linhas = calcularTaxasPermil(dados, campo);

  const canvas = document.getElementById("grafico-taxa-crescimento");
  const altura = Math.max(ALTURA_MIN_GRAFICO, linhas.length * ALTURA_POR_BARRA);
  canvas.parentElement.style.height = `${altura}px`;

  if (estado.graficos.taxaCrescimento) estado.graficos.taxaCrescimento.destroy();
  estado.graficos.taxaCrescimento = new Chart(canvas, {
    type: "bar",
    data: {
      labels: linhas.map((r) => r.nome),
      datasets: [
        { label: "2023→2024", data: linhas.map((r) => r.t2324), backgroundColor: "#5fa8d3", borderRadius: 4 },
        { label: "2024→2025", data: linhas.map((r) => r.t2425), backgroundColor: "#134e79", borderRadius: 4 },
      ],
    },
    options: {
      indexAxis: "y",
      responsive: true,
      maintainAspectRatio: false,
      plugins: { tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${fmtPermil(c.raw)}` } } },
      scales: { x: { ticks: { callback: (v) => fmtPermil(v, 0) } } },
    },
  });
}

// -------------------------------------------------------------------------
// gráficos — expandir (modal) e baixar como PNG
// -------------------------------------------------------------------------
function montarFerramentasGrafico() {
  document.querySelectorAll(".btn-expandir-grafico").forEach((btn) => {
    const wrap = btn.closest(".ferramentas-grafico");
    btn.addEventListener("click", () => expandirGrafico(wrap.dataset.grafico, wrap.dataset.titulo));
  });
  document.querySelectorAll(".btn-baixar-grafico").forEach((btn) => {
    const wrap = btn.closest(".ferramentas-grafico");
    btn.addEventListener("click", () => baixarGrafico(wrap.dataset.grafico, wrap.dataset.titulo));
  });
  document.getElementById("modal-grafico-fechar").addEventListener("click", fecharModalGrafico);
  document.getElementById("modal-grafico").addEventListener("click", (e) => {
    if (e.target.id === "modal-grafico") fecharModalGrafico();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") fecharModalGrafico();
  });
}
function expandirGrafico(idOrigem, titulo) {
  const original = estado.graficos[idOrigem];
  if (!original) return;
  document.getElementById("modal-grafico-titulo").textContent = titulo || "Gráfico";
  document.getElementById("modal-grafico").classList.remove("oculto");
  if (estado.graficoModal) estado.graficoModal.destroy();
  const config = {
    type: original.config.type,
    data: original.config.data,
    options: { ...original.config.options, maintainAspectRatio: false, responsive: true },
  };
  estado.graficoModal = new Chart(document.getElementById("modal-grafico-canvas"), config);
}
function fecharModalGrafico() {
  document.getElementById("modal-grafico").classList.add("oculto");
  if (estado.graficoModal) { estado.graficoModal.destroy(); estado.graficoModal = null; }
}
function baixarGrafico(idOrigem, nomeArquivo) {
  const g = estado.graficos[idOrigem];
  if (!g) return;
  const link = document.createElement("a");
  link.href = g.toBase64Image("image/png", 1);
  const nomeSeguro = (nomeArquivo || idOrigem).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "_");
  link.download = `${nomeSeguro}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

// -------------------------------------------------------------------------
// exportar PDF (impressão do navegador) — mostra o filtro ativo no topo
// -------------------------------------------------------------------------
function montarExportarPdf() {
  document.getElementById("btn-exportar-pdf").addEventListener("click", () => window.print());
  window.addEventListener("beforeprint", () => {
    const el = document.getElementById("impressao-data");
    if (el) el.textContent = new Date().toLocaleString("pt-BR");
  });
}

// -------------------------------------------------------------------------
iniciar().catch((e) => {
  document.getElementById("carregando").innerHTML = `<div style="color:#c1443c;max-width:420px;text-align:center">Erro ao carregar os dados do painel:<br>${e.message}<br><br>Confira se a pasta <b>dados/</b> está junto do index.html.</div>`;
  console.error(e);
});
