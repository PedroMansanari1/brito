# Brito

CLI de agentes para desenvolvimento, com grafo de conhecimento do código (símbolos, chamadas, imports) e memória em grafo.

## Instalação

Requer Node >= 20.

```bash
# uma linha
curl -fsSL https://raw.githubusercontent.com/wilsonbrito/brito/main/install.sh | bash

# ou direto do GitHub
npm i -g github:wilsonbrito/brito

# ou clonando
git clone https://github.com/wilsonbrito/brito && cd brito
npm install && npm run build && npm link
```

## Configuração

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Variáveis opcionais: `BRITO_MODEL`, `BRITO_EFFORT`, `BRITO_EXPLORE_MODEL`, `BRITO_LEARN_MODEL`, `BRITO_HOME`, `BRITO_CONFIG`, `BRITO_COLOR`.

## Uso

```bash
cd seu-projeto
brito            # abre o REPL
brito index      # indexa o código no grafo
```

No REPL: `/model`, `/effort`, `/reasoning`.

## Desenvolvimento

```bash
npm run dev        # roda via tsx
npm run typecheck
npm test
```

## Licença

MIT
