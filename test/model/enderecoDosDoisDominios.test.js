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

  // A consulta do domínio novo procura os DOIS, e nessa ordem: o que veio e o
  // canônico. Se um dia o cadastro passar a guardar o novo, ele acha pelo primeiro.
  const doNovo = consultas[1];
  assert.deepEqual(doNovo.hosts.$in, ["bruna.shapeapp.fit", "bruna.gofitnow.fit"]);
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
  // A regra que separa ler de escrever: aceitar dois na leitura é conveniência;
  // mostrar dois seria dar à mesma cliente dois endereços canônicos.
  assert.equal(dominio.hostOf("bruna"), "bruna.gofitnow.fit");
  assert.deepEqual(dominio.BASE_DOMAINS, ["gofitnow.fit", "shapeapp.fit", "vafit.app"]);
});
