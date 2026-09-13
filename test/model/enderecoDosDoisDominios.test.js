const test = require("node:test");
const assert = require("node:assert");

const Center_model = require("../../model/Center_model.js");
const dominio = require("../../lib/domain.js");

// O ENDEREÇO NOS DOIS DOMÍNIOS NOSSOS.
//
// Desde 25/08/2026 o produto responde em `shapeapp.fit` (marca nova) e em
// `gofitnow.fit` (o endereço que os clientes já têm salvo). O registro de cada
// cliente continua guardando UM endereço, o canônico — e é a leitura que
// normaliza.
//
// Este teste existe porque a correção não é óbvia de ver: os testes de tenant
// dublam `byHost` inteiro, então nenhum deles passaria perto disto. Foi um teste
// ponta a ponta contra o servidor real que mostrou o furo, depois de o `domain.js`
// já aceitar os dois — o `X-Instance-Host` não passa por ele, passa por aqui.
function modeloComColecao(registrados) {
  const consultas = [];
  const app = {
    mongodb: {
      async centralDb() {
        return {
          collection() {
            return {
              async findOne(consulta) {
                consultas.push(consulta);
                const querendo = consulta.hosts && consulta.hosts.$in ? consulta.hosts.$in : [consulta.hosts];
                const achou = registrados.find((r) => querendo.includes(r.host));
                return achou ? { instance: achou.instance, hosts: [achou.host], active: true } : null;
              },
            };
          },
        };
      },
    },
  };
  return { modelo: new Center_model(app), consultas };
}

test("o endereço no domínio novo encontra o cliente cadastrado no antigo", async () => {
  const { modelo, consultas } = modeloComColecao([
    { host: "bruna.gofitnow.fit", instance: "bruna" },
  ]);

  assert.equal((await modelo.byHost("bruna.gofitnow.fit")).instance, "bruna");
  assert.equal((await modelo.byHost("bruna.shapeapp.fit")).instance, "bruna");
  assert.equal((await modelo.byHost("BRUNA.ShapeApp.fit:443")).instance, "bruna");

  // A consulta procura o endereço que VEIO primeiro, e depois o mesmo rótulo em
  // todo domínio nosso. A ordem importa: quem chega pelo endereço gravado acha no
  // primeiro candidato, sem percorrer os outros.
  //
  // São TODOS os domínios, e não só o canônico, porque o cadastro guarda o host
  // do dia em que o cliente nasceu — e esse dia pode ser anterior à marca atual.
  const doNovo = consultas[1];
  assert.equal(doNovo.hosts.$in[0], "bruna.shapeapp.fit", "o que veio vem primeiro");
  // Sem repetir o que já é o primeiro: uma lista com o mesmo host duas vezes
  // funcionaria e diria que ninguém olhou.
  assert.deepEqual(
    doNovo.hosts.$in,
    ["bruna.shapeapp.fit", ...dominio.BASE_DOMAINS.map((b) => `bruna.${b}`).filter((h) => h !== "bruna.shapeapp.fit")]
  );
});

test("domínio próprio do cliente não ganha candidato nenhum", async () => {
  const { modelo, consultas } = modeloComColecao([
    { host: "treinos.marlon.com.br", instance: "marlon" },
  ]);

  assert.equal((await modelo.byHost("treinos.marlon.com.br")).instance, "marlon");
  // Um só candidato: inventar `treinos.gofitnow.fit` aqui seria procurar por um
  // endereço que pode ser de OUTRA pessoa.
  assert.deepEqual(consultas[0].hosts.$in, ["treinos.marlon.com.br"]);
});

test("o domínio novo lê a mesma cliente", async () => {
  // `vafit.app` entrou em 10/09/2026. O cadastro guarda o host canônico em
  // `gofitnow.fit`, e é a leitura que reconhece o terceiro endereço — mesma
  // regra que já valia para o segundo.
  const { modelo } = modeloComColecao([{ host: "bruna.gofitnow.fit", instance: "bruna" }]);
  assert.equal((await modelo.byHost("bruna.vafit.app")).instance, "bruna");
});

test("endereço que não é de ninguém continua não sendo", async () => {
  const { modelo } = modeloComColecao([{ host: "bruna.gofitnow.fit", instance: "bruna" }]);

  assert.equal(await modelo.byHost("naoexiste.shapeapp.fit"), undefined);
  assert.equal(await modelo.byHost("naoexiste.gofitnow.fit"), undefined);
  assert.equal(await modelo.byHost(""), undefined);
  assert.equal(await modelo.byHost(null), undefined);
});

test("o endereço que a gente ESCREVE continua num domínio só", () => {
  // A regra que separa ler de escrever: aceitar três na leitura é conveniência;
  // mostrar três seria dar à mesma cliente três endereços canônicos.
  //
  // 13/09/2026: o canônico virou `vafit.app`. A regra não mudou — mudou de qual
  // domínio ela fala.
  assert.equal(dominio.hostOf("bruna"), "bruna.vafit.app");
  assert.deepEqual(dominio.BASE_DOMAINS, ["vafit.app", "gofitnow.fit", "shapeapp.fit"]);
});

test("o cliente cadastrado no domínio ANTIGO continua sendo achado", async () => {
  // O caso que a troca de marca poderia quebrar sem avisar. Todo cliente de hoje
  // está gravado em `bruna.gofitnow.fit`, e é esse endereço que está no atalho da
  // tela inicial deles.
  const { modelo } = modeloComColecao([{ host: "bruna.gofitnow.fit", instance: "bruna" }]);

  for (const host of ["bruna.gofitnow.fit", "bruna.shapeapp.fit", "bruna.vafit.app"]) {
    assert.equal((await modelo.byHost(host)).instance, "bruna", host);
  }
});
