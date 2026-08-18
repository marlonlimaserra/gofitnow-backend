// As FOTOS do catálogo de alimentos, vistas deste lado.
//
// A collection `food_images` vive no banco CENTRAL e é do painel: ele cria,
// indexa e escreve. Daqui é só leitura — a mesma divisão de `instances`, ao
// contrário.
//
// ── Por que este backend serve a imagem, se o painel já serve ─────────────
//
// Porque o app não fala com o painel. Ele conhece um endereço só, o do backend
// dele; apontar uma `<img>` do aplicativo para `backend-center.gofitnow.fit`
// amarraria a tela do aluno à disponibilidade do painel e a mais um domínio
// para configurar, medir e manter no ar.
//
// Os bytes são os mesmos, lidos da mesma collection. O que muda é de quem é a
// porta.
function FoodImage_model(app) {
  this.app = app;
}

// O nome do alimento vira a chave: "Peito de frango grelhado" →
// "peito-de-frango-grelhado". A MESMA função do painel — as duas leem a mesma
// collection, então elas têm de concordar sobre o que é uma chave válida.
function slug(texto) {
  return String(texto || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

FoodImage_model.prototype.collection = async function () {
  // centralDb: a foto é do catálogo, que é de todos os clientes — não do banco
  // de uma instância.
  const db = await this.app.mongodb.centralDb();
  return db.collection("food_images");
};

FoodImage_model.prototype.byKey = async function (key) {
  const chave = slug(key);
  if (!chave) return undefined;
  const col = await this.collection();
  return (await col.findOne({ key: chave })) || undefined;
};

module.exports = FoodImage_model;
module.exports.slug = slug;
