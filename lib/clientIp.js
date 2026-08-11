// Where the request really came from. Behind nginx `req.ip` is always
// 127.0.0.1, so the forwarded headers are what carry the truth — same
// precedence as sprinthub, most specific first.
function clientIp(req) {
  try {
    if (!req || !req.headers) return null;

    let ip =
      req.headers["cf-connecting-ip"] ||
      req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      (req.socket && req.socket.remoteAddress) ||
      req.ip ||
      null;

    // x-forwarded-for is a chain: the first entry is the original client.
    if (ip && ip.indexOf(",") !== -1) ip = ip.split(",")[0].trim();
    if (ip === "::1" || ip === "::ffff:127.0.0.1") ip = "127.0.0.1";

    return ip || null;
  } catch (error) {
    return null;
  }
}

module.exports = clientIp;
