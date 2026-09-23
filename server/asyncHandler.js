// Envuelve una ruta async para que cualquier error caiga en el middleware de errores de
// Express en vez de colgar el request.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

module.exports = asyncHandler;
