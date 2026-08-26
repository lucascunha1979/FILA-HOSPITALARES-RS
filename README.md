# Painel Regulação RS — deploy no GitHub Pages (v2)

Site estático (não precisa de build, servidor, nem Node/Python instalado para
rodar). Só precisa dos arquivos desta pasta publicados em algum lugar que
sirva arquivos estáticos — o GitHub Pages faz isso de graça.

## Novidades desta versão (v2, 21/08/2026)

- **Mapas com fundo real (OpenStreetMap).** Antes os dois mapas (Fila de
  Espera e População) só mostravam os municípios coloridos sobre fundo
  branco, sem nenhuma referência geográfica — corrigido adicionando a
  camada de tiles do OpenStreetMap.
- **Linha "Total" no gráfico de Central de Regulação**, igual à página
  oficial da SES-RS (antes só mostrava Estadual/Municipal/Regional).
- **Rankings por Especialidade Mãe e Sub Especialidade mostram TODAS as
  categorias**, não mais só as 12 maiores — o painel agora tem scroll
  interno para ver a lista completa.
- **Novo gráfico: Taxa de crescimento populacional por 1.000 habitantes
  (‰)**, 2023→2024 e 2024→2025, agregável por região ou macrorregião de
  saúde (aba População).
- **Todo gráfico ganhou dois botões**: expandir (abre num modal maior) e
  baixar como imagem PNG.
- **Botão "Exportar PDF"** na barra de filtros: abre a caixa de impressão do
  navegador (escolha "Salvar como PDF" no destino). Um banner fixo mostra
  o filtro ativo (macrorregião/região/município) no topo — inclusive no PDF
  gerado — para quem for ler o PDF depois não se perder sobre o que está
  vendo.
- **CDN com fallback duplo** para Leaflet e Chart.js (se um CDN falhar por
  bloqueio de rede/extensão do navegador, o outro assume automaticamente).

## Passo a passo (GitHub Pages)

1. Crie um repositório novo no GitHub (pode ser público), por exemplo
   `regulacao-rs-dashboard`.
2. Copie **todo o conteúdo desta pasta** (`index.html`, `style.css`, `app.js`
   e a pasta `dados/` inteira) para dentro do repositório — na raiz, sem
   subpasta.
3. Suba (commit + push) esses arquivos para a branch `main`.
4. No GitHub: **Settings → Pages → Build and deployment → Source** = "Deploy
   from a branch", **Branch** = `main` / pasta `/ (root)`. Salve.
5. Em 1–2 minutos o site fica no ar em
   `https://SEU-USUARIO.github.io/regulacao-rs-dashboard/`.

Não precisa de nenhuma chave de API nem configuração adicional — os gráficos
(Chart.js) e o mapa (Leaflet, com tiles OpenStreetMap) são carregados de um
CDN público, e os dados são os arquivos JSON/GeoJSON da pasta `dados/`.

## Como testar localmente antes de publicar

Navegadores bloqueiam `fetch()` de arquivo local por segurança
(`file:///…`), então abrir o `index.html` com duplo clique pode não carregar
os dados. O jeito certo de testar localmente:

**Com Python (já vem no Windows/Mac/Linux geralmente):**
```
cd dashboard_rs
python -m http.server 8000
```
Depois abra `http://localhost:8000` no navegador.

**Com VS Code:** extensão "Live Server", botão direito no `index.html` →
"Open with Live Server".

Se algo não carregar, aperte F12 no navegador (aba Console) e me mande a
mensagem de erro.

## Como atualizar os dados todo mês

Não precisa mexer no `index.html`/`style.css`/`app.js` — só trocar o
conteúdo da pasta `dados/`:

1. Rode o robô de extração (`robo_extrair_completo_v7.py`/`_colab_v7.ipynb`,
   o mais recente) → gera um novo `extracao_regulacao_rs_AAAA-MM-DD.xlsx`.
2. Rode `preparar_dashboard_colab_v1.ipynb` (ou `prep_dados_dashboard.py`)
   apontando para esse novo xlsx (e o mesmo `mapa_saude_rs.gpkg`, que não
   muda) → gera uma nova pasta `dados_site/`.
3. Substitua o conteúdo de `dados/` no repositório pelos novos arquivos e
   suba (commit + push). O `meta.json` novo já vem com a data de extração
   atualizada, que aparece automaticamente no cabeçalho do site.

## Estrutura de dados esperada pelo site (`dados/`)

| Arquivo | Precisa ter |
|---|---|
| `municipios.geojson` | 1 feature por município, com geometria + campos de fila e população |
| `ranking_especialidade_por_mun.json` | objeto `{ "nome do município": [ {EspecialidadeMae, Total_Fila, ...} ] }` |
| `ranking_subespecialidade_por_mun.json` | igual, com `SubEspecialidade` |
| `tempo_mediano_subespecialidade.json` | lista de objetos por sub especialidade (estadual) |
| `historico_especialidade_mae.json` | lista de objetos, 1 por (mês, especialidade) |
| `historico_central_regulacao.json` | lista de objetos, 1 por mês (precisa do campo `Total Fila de Espera`, usado na linha "Total") |
| `populacao_por_macrorregiao.json` / `populacao_por_regiao_saude.json` | agregados de população, com `pop_2023`, `pop_2024`, `pop_2025` (usados na taxa por 1.000 hab) |
| `meta.json` | `{ data_extracao_fila, municipios, gerado_em }` |

Se os nomes dos campos dentro desses arquivos mudarem, é preciso ajustar
`app.js` (as constantes `CAMPO_MUN`, `CAMPO_REGIAO`, `CAMPO_MACRO` no topo do
arquivo, e os nomes de coluna usados em cada função `render...`).

## Como isso foi verificado antes de entregar

- HTML validado (tags balanceadas) e todos os `id` usados no `app.js`
  conferidos contra o `index.html`.
- `app.js` validado sintaticamente (`node --check`).
- Teste automatizado com `jsdom` simulando um navegador real: carrega o
  `index.html`, injeta os dados reais de `dados/`, roda o `app.js` de
  ponta a ponta e confere que os KPIs, os 7 gráficos (incluindo a nova
  linha "Total" e o novo gráfico de taxa por 1.000 hab) e o filtro por
  macrorregião funcionam sem lançar nenhum erro. Isso é mais rigoroso do
  que a versão anterior, que só tinha sido conferida por leitura de
  código.
- **Ainda não testado num navegador real** (o ambiente onde isso foi gerado
  não tem acesso à internet para carregar tiles/CDN de verdade) — recomendo
  testar localmente (ver seção acima) antes de publicar, e me avisar se
  algo parecer errado visualmente (o teste automatizado confere a lógica,
  não a aparência).

## Pendências conhecidas (não bloqueiam o deploy)

- Nenhuma pendência de dado conhecida no momento — a extração de
  Especialidade Mãe está em 74/74 desde o robô v6, e o robô v7 corrige a
  extração incompleta de Tempo Mediano por Sub Especialidade (ver
  `investigacao_powerbi_regulacao_rs_v11.md`).
