exports.handler = async () => ({
  statusCode: 200,
  body: JSON.stringify({ ok: true, message: "Migration already completed" })
});
