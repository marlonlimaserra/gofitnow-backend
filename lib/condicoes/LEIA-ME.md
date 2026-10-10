# Uma condição por arquivo

*"em breve vamos ter um montão de condições, e tenho medo de dar conflito
quando outro programador for mexer; no SprintHub cada filtro é um arquivo
separado"* (10/10/2026).

Ele está certo, e o problema tem nome: **registro central**. Com um array só,
toda adição mexe nas mesmas linhas — duas pessoas acrescentando condições na
mesma semana conflitam sempre, e o conflito é no pior lugar possível, no meio
de uma lista onde um `>>>>>>>` passa despercebido na revisão.

## Como acrescentar uma condição

Crie um arquivo aqui. **Só isso** — não há índice para editar, nem lista para
registrar: `index.js` lê a pasta.

```js
module.exports = {
  chave: "altura",          // o id; vira `filters.cond_altura` na tradução
  categoria: "contato",     // uma das de `categorias.js`
  icone: "Ruler",           // nome de ícone do lucide (o painel mapeia)
  tipo: "numero",           // booleano | opcao | texto | numero | data | pessoa
  campo: "height",          // o caminho no documento da PESSOA
};
```

Zero linha compartilhada: dois programadores acrescentando condições diferentes
na mesma tarde não se encontram em arquivo nenhum.

## Os campos opcionais, e quando cada um aparece

- **`padrao`** — o operador que vem escolhido. De nome se pergunta o que
  *contém*; de e-mail, se *existe*. Sem isto, o padrão seria por TIPO, e os dois
  são texto.
- **`opcoes`** — a lista fixa de um `tipo: "opcao"`. O tradutor recusa valor
  fora dela.
- **`fonte`** — as opções vêm de uma lista VIVA que o painel resolve
  (`"unidades"`). Nada de embutir no catálogo o que muda por conta e por
  pessoa.
- **`montar(valor, operador)`** — quando a condição não é um campo simples.
  Devolve o `$match` inteiro. É o caso de tudo que é derivado (acesso ao app é
  senha E não-bloqueado) e de tudo que precisa tratar a ausência de três
  formas (vazio, nulo, inexistente).
- **`precisaDoVinculo`** — o campo não mora na pessoa, e sim no vínculo com o
  profissional (hoje só o status). Avisa o modelo a subir a junção ANTES do
  filtro. Ela é cara, então não suba sem necessidade.

## O que NÃO fazer aqui

Nada neste arquivo vira caminho de consulta sem passar pelo `index.js`: é ele
que confere a chave, o operador e o tipo do valor. Um `montar` que recebesse
valor não validado seria o buraco que o catálogo existe para fechar — e por
isso a validação das `opcoes` roda **antes** dele.
