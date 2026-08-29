// `all_users` — UMA PESSOA, uma conta, em quantas instâncias ela quiser.
//
// ── O problema que ela resolve ────────────────────────────────────────────
//
// O portal (`app.gofitnow.fit`) precisa responder "este e-mail é de qual
// cliente?" antes de existir sessão. Até aqui isso era feito VARRENDO todos os
// bancos de instância, um por um, em série. Com cinco clientes custava 65 ms;
// medido em 23/08/2026, cada banco custa ~1,1 ms, então mil clientes custariam
// mais de um segundo — numa rota pública, sem sessão, que qualquer um pode
// chamar. E pior: o índice sozinho não resolveria o caso do e-mail que NÃO
// existe, porque para ter certeza de que não existe seria preciso varrer tudo
// de novo. Aqui a resposta é uma consulta indexada nos dois casos.
//
// ── A SENHA NÃO MORA AQUI, E ISSO É O PONTO MAIS IMPORTANTE ───────────────
//
// A primeira versão deste desenho guardava a senha na central, para a pessoa
// ter uma só em todos os clientes. É cômodo e é um buraco de segurança:
//
//   O admin de QUALQUER instância pode definir a senha de um usuário dela
//   (é a tela de Usuários, e tem de ser assim). Com a senha compartilhada,
//   o admin da academia definiria a senha de alguém que também é paciente
//   de uma clínica — e entraria na clínica como aquela pessoa.
//
// Os clientes não confiam uns nos outros, e credencial compartilhada entre
// inquilinos transforma "admin do meu negócio" em "admin da conta alheia".
// Por isso a senha continua onde sempre esteve: em `gofitnow_<inst>.users`,
// uma por instância, e o login continua sendo conferido lá.
//
// O ganho de velocidade não dependia disso. Descobrir DE QUEM é um e-mail e
// PROVAR que é ele são perguntas diferentes: a primeira é pública e precisa ser
// rápida, a segunda é privada e é de cada cliente.
//
// ── A divisão: o que é da PESSOA e o que é do NEGÓCIO ─────────────────────
//
// Aqui mora o que atravessa os clientes sem ser credencial: e-mail, nome,
// WhatsApp, foto, e em quais instâncias a pessoa entra.
//
// Não mora aqui nada que um negócio decidiu sobre alguém: senha, papel,
// chave-mestra, ativo, tipo, categoria, vínculos e preferências continuam em
// `gofitnow_<instancia>.users`. A academia não pode herdar que você é
// administrador na clínica.
//
// Nome e WhatsApp ficam nos DOIS lugares, de propósito. Cada instância guarda o
// seu (a clínica pode registrar "Maria Silva" e a academia "Maria"), e a
// central guarda o ÚLTIMO que alguém escreveu, em qualquer instância. O da
// central não manda em ninguém: ele é o padrão de quando essa pessoa entrar
// numa instância nova, e é o nome que o portal mostra.
//
// ── Espelho, não fonte ────────────────────────────────────────────────────
//
// Este documento inteiro é ESPELHO: a verdade continua nos bancos de instância,
// e a reconciliação (`reconstruir`) pode refazê-lo do zero a qualquer momento.
// É a regra que o Portal_model já pedia quando previu este índice — "erro de
// índice volta a varrer em vez de trancar a porta".
//
// Ser só espelho é o que torna este atalho seguro: nada aqui é insubstituível,
// e apagar a collection inteira custa uma reconciliação, não um chamado de
// suporte.
function AllUser_model(app) {
  this.app = app;
}

AllUser_model.prototype.collection = async function () {
  // centralDb, e não connectToServer: esta collection é do compartilhado. Ela
  // é lida sem instância nenhuma no contexto — é a rota do portal, que roda
  // antes de se saber qual é o cliente.
  const db = await this.app.mongodb.centralDb();
  return db.collection("all_users");
};

function normalizar(email) {
  return String(email || "").trim().toLowerCase();
}

// ── A CHAVE DE BUSCA POR NOME ─────────────────────────────────────────────
//
// O mesmo `nameSort` que `exercises` e `foods` já usam: minúsculo e sem acento.
// Sem ele, procurar "jose" não acha "José", e ordenar põe "Ávila" depois de
// "Zuza" porque a comparação é por código de caractere.
//
// É um campo INTEIRO e não a inicial, e a diferença importa quando forem
// milhões: um índice sobre o nome todo responde "começa com m" por varredura de
// FAIXA (de "m" até "n"), que é a mesma coisa que a inicial faria — e responde
// também "começa com mar", que a inicial não sabe responder. Guardar só a letra
// daria 26 baldes gigantes, e o Mongo teria de abrir o balde inteiro do "m"
// para depois descartar quase tudo.
function chaveDeNome(nome) {
  return String(nome || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

AllUser_model.prototype.data = async function (email) {
  const limpo = normalizar(email);
  if (!limpo) return undefined;

  const col = await this.collection();
  return (await col.findOne({ email: limpo })) || undefined;
};

// As instâncias em que este e-mail entra, direto do índice.
//
// Devolve `undefined` — e não lista vazia — quando o e-mail é DESCONHECIDO.
// A diferença importa: "não conheço este e-mail" manda quem chamou varrer os
// bancos para conferir, enquanto "conheço e ele não está em instância nenhuma"
// é uma resposta completa. Uma lista vazia para os dois casos faria a queda
// para a varredura nunca acontecer, e um índice defasado trancaria a porta.
AllUser_model.prototype.instancesForEmail = async function (email) {
  const doc = await this.data(email);
  if (!doc) return undefined;
  return Array.isArray(doc.instances) ? doc.instances : [];
};

// ── A ESCRITA ─────────────────────────────────────────────────────────────
//
// Chamada pelo User_model depois de cada gravação de usuário. Recebe só o que é
// da pessoa; o resto do documento de instância nem chega aqui.
//
// `$set` com o que veio, e nada mais: quem salva só o telefone não pode apagar
// o nome. Por isso os campos são montados um a um em vez de espalhar o objeto.
AllUser_model.prototype.espelhar = async function (email, dados = {}) {
  const limpo = normalizar(email);
  if (!limpo) return;

  const set = { updatedAt: new Date() };

  // ÚLTIMO VENCE: nome e WhatsApp da central são sempre os da escrita mais
  // recente, venha de qual instância vier. É o que se combinou — a central
  // mantém o último, e cada instância mantém o seu.
  if (dados.name !== undefined) {
    set.name = String(dados.name || "").trim();
    set.nameSort = chaveDeNome(set.name);
  }
  if (dados.whatsapp !== undefined) set.whatsapp = String(dados.whatsapp || "").trim();

  // A FOTO atravessa os clientes — foi o pedido, e ao contrário da senha ela
  // não é credencial: o pior que um admin de outra instância faz é trocar a
  // foto, não entrar na conta.
  if (dados.avatarAt !== undefined) set.avatarAt = dados.avatarAt;

  const update = {
    $set: set,
    $setOnInsert: { email: limpo, createdAt: new Date() },
  };

  // A instância entra na lista sem duplicar. `$addToSet` no mesmo update do
  // `$set` porque são a mesma escrita do ponto de vista de quem chamou.
  if (dados.instance) update.$addToSet = { instances: String(dados.instance) };

  const col = await this.collection();
  await col.updateOne({ email: limpo }, update, { upsert: true });
};

// ── A FOTO, ESPELHADA ─────────────────────────────────────────────────────
//
// A foto DE VERDADE continua em `gofitnow_<inst>.avatars`, uma por instância:
// cada negócio mostra a que tem. O que vem para cá é uma CÓPIA, e ela existe
// para um leitor só — o painel da central, onde dá para ver quem é a pessoa
// por trás do e-mail.
//
// Fica numa collection separada de `all_users` pelo mesmo motivo que já separa
// lá dentro da instância: no documento da pessoa a imagem viajaria junto em
// toda leitura do índice, e o índice é lido a cada login do portal, para
// mostrar 40 pixels de foto que ninguém pediu naquele instante.
//
// `instance` guarda de qual cliente veio a cópia. Sem isso, ao ver uma foto
// estranha no painel não haveria como saber quem a colocou.
//
// ── O tamanho, para quando forem muitos ───────────────────────────────────
//
// Cada foto sai do navegador com 512×512 em JPEG — dezenas de KB. Com 225
// pessoas é irrelevante; com um milhão seriam algumas dezenas de gigabytes, e
// aí vale guardar aqui uma miniatura em vez da imagem inteira. Não é para
// agora: a redução exigiria uma biblioteca de imagem no servidor, e o problema
// ainda não existe. Fica o número para quando existir.
AllUser_model.prototype.avatarCollection = async function () {
  const db = await this.app.mongodb.centralDb();
  return db.collection("all_avatars");
};

AllUser_model.prototype.espelharFoto = async function (email, { mime, data, size, instance }) {
  const limpo = normalizar(email);
  if (!limpo || !data) return;

  const col = await this.avatarCollection();
  await col.updateOne(
    { email: limpo },
    {
      // ÚLTIMO VENCE, como o resto do espelho: a foto da central é a da troca
      // mais recente, em qualquer instância.
      $set: { email: limpo, mime, data, size, instance: instance || null, updatedAt: new Date() },
    },
    { upsert: true }
  );
};

// Apagar a foto numa instância NÃO apaga a cópia da central quando a pessoa
// ainda tem foto em outra: a cópia é "a última que se viu", e sumir com ela
// deixaria o painel sem rosto para alguém que tem um. Só sai quando a que se
// apagou é justamente a que está espelhada.
AllUser_model.prototype.apagarFotoEspelhada = async function (email, instance) {
  const limpo = normalizar(email);
  if (!limpo) return;

  const col = await this.avatarCollection();
  await col.deleteOne({ email: limpo, instance: instance || null });
};

// A pessoa saiu de uma instância. Só o nome da instância sai da lista; o
// documento FICA, porque ela pode ter conta em outra — e apagá-lo faria o
// portal deixar de saber onde ela entra nas demais.
AllUser_model.prototype.desvincular = async function (email, instance) {
  const limpo = normalizar(email);
  if (!limpo || !instance) return;

  const col = await this.collection();
  await col.updateOne(
    { email: limpo },
    { $pull: { instances: String(instance) }, $set: { updatedAt: new Date() } }
  );
};

// Não existe `conferirSenha` aqui, de propósito. Quem prova identidade é o
// `User_model` da instância — ver o bloco da senha no topo.

// ── A RECONCILIAÇÃO ───────────────────────────────────────────────────────
//
// Varre todas as instâncias e reescreve o índice a partir da verdade. É o que
// torna este atalho seguro: se o espelhamento falhar em algum ponto, ou se
// alguém mexer num banco por fora, isto conserta.
//
// É também a MIGRAÇÃO inicial — não existem duas rotinas, porque construir do
// zero e consertar são a mesma operação.
//
// ── O conflito, e como ele deixou de doer ─────────────────────────────────
//
// O mesmo e-mail pode estar em duas instâncias (em 23/08/2026 eram dois casos).
// Vence a gravação MAIS RECENTE pelo `updatedAt`, e o que ela decide é só nome,
// WhatsApp e foto — coisas cosméticas. A senha NÃO entra nesta conta, então
// ninguém perde acesso a nada por causa de um conflito aqui: cada instância
// continua com a senha dela.
AllUser_model.prototype.reconstruir = async function ({ dryRun = false } = {}) {
  const instanceContext = require("../lib/instance.js");

  const registros = await this.app.api.center.list();
  const ativas = registros.filter((r) => r.active !== false && r.active !== 0);

  // Junta tudo em memória ANTES de escrever: quem é o mais recente de um e-mail
  // só se sabe depois de ver todas as instâncias, e gravar em passadas
  // sucessivas deixaria o índice oscilando entre os dois nomes.
  const porEmail = new Map();
  const conflitos = [];

  for (const registro of ativas) {
    let usuarios = [];
    try {
      usuarios = await instanceContext.run(registro.instance, async () => {
        const col = await this.app.api.user.collection();
        // A projeção NÃO traz `password` nem `salt`. Não é economia de bytes: é
        // a garantia de que nenhum caminho deste arquivo pode, nem por engano,
        // levar credencial para a central.
        return col
          .find(
            { email: { $exists: true, $ne: "" } },
            { projection: { email: 1, name: 1, phone: 1, avatarAt: 1, updatedAt: 1 } }
          )
          .toArray();
      });
    } catch (erro) {
      // Um banco fora do ar não pode produzir um índice que diz que aquelas
      // pessoas não existem — isso trancaria a porta delas. Aborta.
      throw new Error(`instância ${registro.instance} inacessível: ${erro.message}`);
    }

    for (const u of usuarios) {
      const email = normalizar(u.email);
      if (!email) continue;

      const quando = u.updatedAt || new Date(0);
      const atual = porEmail.get(email);

      if (!atual) {
        porEmail.set(email, {
          email,
          name: u.name || "",
          whatsapp: u.phone || "",
          avatarAt: u.avatarAt || null,
          quando,
          instances: [registro.instance],
        });
        continue;
      }

      atual.instances.push(registro.instance);
      conflitos.push({ email, instancias: [...atual.instances] });

      // ÚLTIMO VENCE, e só em coisa cosmética. Campo vazio não vence campo
      // preenchido: uma ficha recém-criada sem telefone não pode apagar o
      // telefone que a outra instância tem.
      if (quando > atual.quando) {
        atual.name = u.name || atual.name;
        atual.whatsapp = u.phone || atual.whatsapp;
        atual.avatarAt = u.avatarAt || atual.avatarAt;
        atual.quando = quando;
      }
    }
  }

  if (dryRun) return { total: porEmail.size, conflitos, gravados: 0 };

  const col = await this.collection();
  let gravados = 0;

  for (const p of porEmail.values()) {
    await col.updateOne(
      { email: p.email },
      {
        $set: {
          name: p.name,
          nameSort: chaveDeNome(p.name),
          whatsapp: p.whatsapp,
          avatarAt: p.avatarAt,
          instances: p.instances,
          updatedAt: new Date(),
        },
        $setOnInsert: { email: p.email, createdAt: new Date() },
      },
      { upsert: true }
    );
    gravados++;
  }

  return { total: porEmail.size, conflitos, gravados };
};

module.exports = AllUser_model;
